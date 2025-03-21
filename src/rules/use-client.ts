import type { Rule } from "eslint";
import type {
  BinaryExpression,
  Expression,
  ExpressionStatement,
  Identifier,
  ImportSpecifier,
  Node,
  Program,
  SpreadElement,
} from "estree";
import globals from "globals";
import { reactEvents } from "./react-events";
import { JSXOpeningElement } from "estree-jsx";
// @ts-expect-error
import Components from "eslint-plugin-react/lib/util/Components";
// @ts-expect-error
import componentUtil from "eslint-plugin-react/lib/util/componentUtil";

const useClientRegex = /^('|")use client('|")/;
const browserOnlyGlobals = Object.keys(globals.browser).reduce<
  Set<Exclude<keyof typeof globals.browser, keyof typeof globals.node>>
>((acc, curr) => {
  if (curr in globals.browser && !(curr in globals.node)) {
    acc.add(curr as any);
  }
  return acc;
}, new Set());

type Options = [
  {
    allowedServerHooks?: string[];
  }
];

const meta: Rule.RuleModule["meta"] = {
  docs: {
    description:
      "Enforce components are appropriately labeled with 'use client'.",
    recommended: true,
  },
  type: "problem",
  hasSuggestions: true,
  fixable: "code",
  schema: [
    {
      type: "object",
      properties: {
        allowedServerHooks: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  ],
  messages: {
    addUseClientHooks:
      '{{hook}} only works in Client Components. Add the "use client" directive at the top of the file to use it.',
    addUseClientBrowserAPI:
      'Browser APIs only work in Client Components. Add the "use client" directive at the top of the file to use it.',
    addUseClientCallbacks:
      'Functions can only be passed as props to Client Components. Add the "use client" directive at the top of the file to use it.',
    addUseClientClassComponent:
      'React Class Components can only be used in Client Components. Add the "use client" directive at the top of the file.',
    removeUseClient:
      "This file does not require the 'use client' directive, and it should be removed.",
  },
};

const create = Components.detect(
  (
    context: Parameters<Rule.RuleModule["create"]>[0],
    _: any,
    util: any
  ): ReturnType<Rule.RuleModule["create"]> => {
    let hasReported = false;
    const instances = [];
    let isClientComponent = false;
    const sourceCode = context.getSourceCode();
    const options = (context.options?.[0] || {}) as Options[0];

    let parentNode: Program;

    function isClientOnlyHook(name: string) {
      return (
        // `useId` is the only hook that's allowed in server components
        name !== "useId" &&
        !(options.allowedServerHooks || []).includes(name) &&
        /^use[A-Z]/.test(name)
      );
    }

    function reportMissingDirective(
      messageId: string,
      expression: Node,
      data?: Record<string, any>
    ) {
      if (isClientComponent || hasReported) {
        return;
      }
      hasReported = true;
      context.report({
        node: expression,
        messageId,
        data,
        *fix(fixer) {
          const firstToken = sourceCode.getFirstToken(parentNode.body[0]);
          if (firstToken) {
            const isFirstLine = firstToken.loc.start.line === 1;
            yield fixer.insertTextBefore(
              firstToken!,
              `${isFirstLine ? "" : "\n"}'use client';\n\n`
            );
          }
        },
      });
    }


    function getBinaryBranchExecutedOnServer(node: BinaryExpression): {
      isGlobalClientPropertyCheck: boolean;
      serverBranch: Rule.Node | null;
    } {
      const isGlobalClientPropertyCheck =
        node.left?.type === "UnaryExpression" &&
        node.left.operator === "typeof" &&
        node.left.argument?.type === "Identifier" &&
        browserOnlyGlobals.has(node.left.argument?.name as any) &&
        node.right?.type === "Literal" &&
        node.right.value === "undefined" &&
        (node.operator === "===" || node.operator === "!==");

      let serverBranch = null;

      if (!isGlobalClientPropertyCheck) {
        return { isGlobalClientPropertyCheck, serverBranch };
      }

      //@ts-expect-error
      const { parent } = node;
      if (!parent) {
        return { isGlobalClientPropertyCheck, serverBranch };
      }

      if (node.operator === "===") {
        serverBranch =
          parent.type === "IfStatement" ||
          parent.type === "ConditionalExpression"
            ? parent.alternate
            : null;
      } else {
        serverBranch =
          parent.type === "IfStatement" ||
          parent.type === "ConditionalExpression"
            ? parent.consequent
            : null;
      }

      return { isGlobalClientPropertyCheck, serverBranch };
    }

    const isNodePartOfSafelyExecutedServerBranch = (
      node: Rule.Node
    ): boolean => {
      let isUsedInServerBranch = false;
      serverBranches.forEach((serverBranch) => {
        if (isNodeInTree(node, serverBranch)) {
          isUsedInServerBranch = true;
        }
      });
      return isUsedInServerBranch;
    };

    const reactImports: Record<string | "namespace", string | string[]> = {
      namespace: [],
    };

    const undeclaredReferences = new Set();

    const serverBranches = new Set<Rule.Node>();

    return {
      Program(node) {
        for (const block of node.body) {
          if (
            block.type === "ExpressionStatement" &&
            block.expression.type === "Literal" &&
            block.expression.value === "use client"
          ) {
            isClientComponent = true;
          }
        }

        parentNode = node;
        const scope = context.getScope();
        // Collect undeclared variables (ie, used global variables)
        scope.through.forEach((reference) => {
          undeclaredReferences.add(reference.identifier.name);
        });
      },

      ImportDeclaration(node) {
        if (node.source.value === "react") {
          node.specifiers
            .filter((spec) => spec.type === "ImportSpecifier")
            .forEach((spac: any) => {
              const spec = spac as ImportSpecifier;
              reactImports[spec.local.name] = spec.imported.name;
            });
          const namespace = node.specifiers.find(
            (spec) =>
              spec.type === "ImportDefaultSpecifier" ||
              spec.type === "ImportNamespaceSpecifier"
          );
          if (namespace) {
            reactImports.namespace = [
              ...reactImports.namespace,
              namespace.local.name,
            ];
          }
        }
      },
      NewExpression(node) {
        // @ts-expect-error
        const name = node.callee.name;
        if (undeclaredReferences.has(name) && browserOnlyGlobals.has(name)) {
          instances.push(name);
          reportMissingDirective("addUseClientBrowserAPI", node);
        }
      },
      CallExpression(expression) {
        let name = "";
        if (
          expression.callee.type === "Identifier" &&
          "name" in expression.callee
        ) {
          name = expression.callee.name;
        } else if (
          expression.callee.type === "MemberExpression" &&
          "name" in expression.callee.property
        ) {
          name = expression.callee.property.name;
        }

        if (
          isClientOnlyHook(name) &&
          // Is in a function...
          context.getScope().type === "function" &&
          // But only if that function is a component
          Boolean(util.getParentComponent(expression))
        ) {
          instances.push(name);
          reportMissingDirective("addUseClientHooks", expression.callee, {
            hook: name,
          });
        }
      },
      Identifier(node) {
        const name = node.name;
        // @ts-expect-error
        if (undeclaredReferences.has(name) && browserOnlyGlobals.has(name)) {
          // find the nearest binary expression so we can see if this instance is being used in a `typeof window === undefined`-like check
          const binaryExpressionNode = findFirstParentOfType(
            node,
            "BinaryExpression"
          ) as BinaryExpression | null;
          if (binaryExpressionNode) {
            const { isGlobalClientPropertyCheck, serverBranch } =
              getBinaryBranchExecutedOnServer(binaryExpressionNode);
            // if this instance isn't part of a server check we report it
            if (!isGlobalClientPropertyCheck) {
              instances.push(name);
              reportMissingDirective("addUseClientBrowserAPI", node);
            } else if (isGlobalClientPropertyCheck && serverBranch) {
              // if it is part of a check, we don't report it and we save the server branch so we can check if future instances are a part of the branch of code safely executed on the server
              serverBranches.add(serverBranch);
            }
          } else {
            // if the usage isn't part of the binary expression, we check to see if it's part of a safely checked server branch and report if not
            if (!isNodePartOfSafelyExecutedServerBranch(node)) {
              instances.push(name);
              reportMissingDirective("addUseClientBrowserAPI", node);
            }
          }
        }
      },
      ExpressionStatement(node) {
        const expression = node.expression as Expression & {
          callee?: Identifier;
          arguments?: Array<Expression | SpreadElement>;
        };
        if (!expression.callee) {
          return;
        }

        if (
          expression.callee &&
          isClientOnlyHook(expression.callee.name) &&
          Boolean(util.getParentComponent(expression))
        ) {
          instances.push(expression.callee.name);
          reportMissingDirective("addUseClientHooks", expression.callee, {
            hook: expression.callee.name,
          });
        }
      },
      // @ts-expect-error
      JSXOpeningElement(node: JSXOpeningElement) {
        const scope = context.getScope();
        const fnsInScope: string[] = [];
        scope.variables.forEach((variable) => {
          variable.defs.forEach((def) => {
            if (isFunction(def)) {
              fnsInScope.push(variable.name);
            }
          });
        });
        scope.upper?.set.forEach((variable) => {
          variable.defs.forEach((def) => {
            if (isFunction(def)) {
              fnsInScope.push(variable.name);
            }
          });
        });

        for (const attribute of node.attributes) {
          if (
            attribute.type === "JSXSpreadAttribute" ||
            attribute.value?.type !== "JSXExpressionContainer"
          ) {
            continue;
          }

          if (reactEvents.includes(attribute.name.name as string)) {
            reportMissingDirective("addUseClientCallbacks", attribute.name);
          }

          if (
            attribute.value?.expression.type === "ArrowFunctionExpression" ||
            attribute.value?.expression.type === "FunctionExpression" ||
            (attribute.value.expression.type === "Identifier" &&
              fnsInScope.includes(attribute.value.expression.name))
          ) {
            reportMissingDirective("addUseClientCallbacks", attribute);
          }
        }
      },
      ClassDeclaration(node) {
        if (componentUtil.isES6Component(node, context)) {
          instances.push(node.id?.name);
          reportMissingDirective("addUseClientClassComponent", node);
        }
      },

      "ExpressionStatement:exit"(
        node: ExpressionStatement & Rule.NodeParentExtension
      ) {
        const value = "value" in node.expression ? node.expression.value : "";
        if (typeof value !== "string" || !useClientRegex.test(value)) {
          return;
        }
        if (instances.length === 0 && isClientComponent) {
          context.report({
            node,
            messageId: "removeUseClient",
            fix(fixer) {
              return fixer.remove(node);
            },
          });
        }
      },
    };
  }
);

function isFunction(def: any) {
  if (def.type === "FunctionName") {
    return true;
  }
  if (def.node.init && def.node.init.type === "ArrowFunctionExpression") {
    return true;
  }
  return false;
}

function findFirstParentOfType(
  node: Rule.Node,
  type: string
): Rule.Node | null {
  let currentNode: Rule.Node | null = node;

  while (currentNode) {
    if (currentNode.type === type) {
      return currentNode;
    }
    currentNode = currentNode?.parent;
  }

  return null;
}

function isNodeInTree(node: Rule.Node, target: Rule.Node): boolean {
  let currentNode: Rule.Node | null = node;

  while (currentNode) {
    if (currentNode === target) {
      return true;
    }
    currentNode = currentNode.parent;
  }

  return false;
}

export const ClientComponents = { meta, create };
