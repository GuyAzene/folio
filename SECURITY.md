# Security

Folio keeps your courses, notes and chats on your own computer. On your behalf it talks to the
model services you connect (your ChatGPT plan, or providers you give an API key), to pi.dev for
Pi's list of OpenRouter's models (the request names only the provider and Folio's Pi release),
to GitHub once a day to see whether a newer Folio is out (the request carries nothing about you;
turn it off in Settings → General), and, when you add them, to MCP servers you choose: programs that run on your Mac with your permissions, or remote
services. Folio asks before each call to a server until you allow it, and keeps their settings and
keys in `~/.folio/mcp.json`, readable only by you. Add only servers you trust. If you find a security problem, please report it privately rather than in a public
issue: use **Report a vulnerability** on this repository's Security tab.

Folio is in early development, so only the latest version on `main` is supported.
