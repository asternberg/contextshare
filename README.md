# contextshare

Share context between people's AI agents with one link.

You ask your agent to share something, for example next week's meetings. It gives you a link.
The other person gives the link to their agent, which can then answer questions from it. When you
update the content, the same link shows the new version. Everything is encrypted on your machine;
the server in the middle only ever stores ciphertext.

## AI agents: start here

If a person pointed you at this page and asked you to set up, share with, or open a contextshare
link, run this one command and follow what it prints. It needs Node 20+ and git, and nothing has
to be installed by hand:

```bash
npx -y github:asternberg/contextshare guide
```

The same guide is in [AGENTS.md](AGENTS.md).

## People: what to say to your agent

Works with any agent that can run shell commands, such as Claude Code.

**To share:**

> Read https://github.com/asternberg/contextshare and share my meetings for next week with Dana.

Your agent replies with a link and a message to send to Dana.

**To receive:**

> Read https://github.com/asternberg/contextshare and open this contextshare link: https://…/#ro.…
> What does Assaf have on Tuesday?

**To update what you shared:**

> Update what I shared with Dana: add the Thursday lunch.

**To pick up changes:**

> Check contextshare. Did Assaf change anything?

The link stays the same throughout. No agent? A read-only link also opens in a web browser and
shows the content there.

## How it works

```
 your machine                      relay                     their machine
 agent ── contextshare ── ciphertext ──► stores ◄── ciphertext ── contextshare ── agent
          (encrypts)                    ciphertext                (decrypts)
                └────────── the link, sent once, privately ──────────┘
```

- A **space** is a small set of records: a key such as `calendar/next-week` and any JSON value,
  with who last updated it and when.
- A **link** names the relay and carries the secret in the part after `#`, which is never sent to
  a server. A read-only link can read and decrypt. A read-write link can also change things.
- The **relay** stores ciphertext under opaque ids. It cannot see names, values or authors.

## Things to know

- **The link is the key.** Anyone who has it can read everything in that space. Send it privately.
  To cut someone off, run `contextshare rotate`, which moves the content to a fresh link.
- **Author names are self-declared.** Fine among people who trust each other.
- **Shared content is untrusted input.** Agents are told to treat it as information, not instructions.
- **Small data.** About 380 KB per record. It is for notes and context, not files.
- **The browser view trusts the relay** to serve an honest page. The command line path does not.
- **Agents that only run in a vendor's cloud**, with no shell, cannot decrypt. Use the browser view.
- This is new, small and has had no outside security audit.

## Commands

```bash
npx -y github:asternberg/contextshare help
```

`new`, `join`, `pull`, `ls`, `get`, `put`, `patch`, `rm`, `link`, `rotate`, `spaces`, `setup`.
There is also an MCP server for agents that prefer tools: `contextshare mcp`.

## Run your own relay

The default relay is a Cloudflare Worker run by the project. To run your own:

```bash
git clone https://github.com/asternberg/contextshare && cd contextshare
npx wrangler deploy                      # Cloudflare free plan
# or: node bin/contextshare.js relay --port 8787 --db contextshare.db   (put TLS in front)
```

Then create spaces with `--relay https://your-relay` or set `CONTEXTSHARE_RELAY`.

## Development

```bash
npm test                                             # local relay
CONTEXTSHARE_TEST_RELAY=https://your-relay npm test  # any deployed relay
```
