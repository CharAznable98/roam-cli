# Markdown Rendering Boundary

RoamCli message bodies will render complete Markdown for agent messages, including GFM, Shiki-backed code highlighting, math, Mermaid, and alert-style syntax, but raw HTML will not be inserted into the message DOM. HTML-like output should be treated as artifact preview content rendered in a sandboxed iframe with scripts disabled by default because mature LLM web clients either avoid raw HTML in message bodies or isolate it behind preview surfaces, and direct HTML rendering carries persistent XSS risk even when sanitization is attempted.
