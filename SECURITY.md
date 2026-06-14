# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Floe, please report it privately. Do not open a public issue, as that may expose the vulnerability before a fix is available.

There are two ways to report:

1. **GitHub Security Advisories (preferred):** Open the [Security tab](https://github.com/jannskiee/floe/security/advisories/new) and select "Report a vulnerability". This keeps the report private until a fix is released.
2. **Email:** Send the details to paredesjancarlo99@gmail.com.

Please include as much of the following as possible:

- A description of the vulnerability and its impact
- Steps to reproduce it
- The affected component (client, server, or CLI)
- Any relevant logs, screenshots, or proof of concept

## What to Expect

- We aim to acknowledge your report within 72 hours.
- We will investigate and keep you updated on our progress.
- Once a fix is ready, we will release it and credit you in the advisory, unless you prefer to remain anonymous.

## Scope

This policy covers the Floe web client, signaling server, and CLI in this repository. The signaling server brokers connection setup only. File data is transferred directly between peers over encrypted WebRTC data channels and is never stored or inspected by Floe infrastructure.

## Supported Versions

Security fixes are applied to the latest release on the `main` branch. Please make sure you are using the most recent version before reporting an issue.
