---
"eslint-plugin-react-server-components": minor
---

Making checks for window usage more robust to not require "use client" when safely accessed behind a `typeof window !== 'undefined'` or `typeof document !== 'undefined'`check.

For example:
```
const HREF = typeof window !== 'undefined' ? window.location.href : '';

const MyComponent = () => {
    return <div>{HREF}</div>;
}
```
does not need to be marked with a "use client" because all of it's client only actions are behind a server check.