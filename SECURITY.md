# Security policy

## Supported versions

Security fixes are made for the latest release only.

## Reporting a vulnerability

Please **don't open a public issue** for a vulnerability. Report it privately instead:

1. Go to the repository's [Security tab](https://github.com/MagnusJohansson/siglent-sds-mcp/security).
2. Click **Report a vulnerability**.

Please include:
- the version, and how you run it (npm, Docker, from source);
- the tool call or input that triggers the problem;
- what reaches the instrument or the network, and what you expected instead;
- the instrument model and firmware, if you tested on hardware.

This project is maintained by one person in their spare time, so responses are best effort. Fixes are released through GitHub Releases, npm and GHCR, and disclosed in a GitHub Security Advisory with credit to the reporter, unless you'd rather not be named.

## Scope

Tool arguments come from a language model, which may have read attacker-controlled content, so they should be treated as untrusted. Ways for tool input to change the instrument's state through a tool marked read-only, to put unintended commands on the wire, or to reach hosts other than the instrument are in scope.

The instrument's SCPI port (TCP 5025) has no authentication of its own. Anyone who can reach it controls the instrument directly, without this server; that is not a vulnerability in this project.
