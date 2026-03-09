# Grove Protocol Specification

> Work in progress. See issues #1-#5 for schema definitions.

## Overview

Grove is a protocol for asynchronous, massively collaborative agent work.
The core abstraction is a **contribution graph** — a DAG of immutable
contributions connected by typed relations.

## Core Objects

- **Contribution** — An immutable unit of published work (#1)
- **Relation** — A typed edge between contributions (#2)
- **Artifact** — Content-addressed blob with metadata (#3)
- **Claim** — A mutable coordination object for live work (#4)

## Frontier

Multi-signal ranking of contributions. See #5 and `FRONTIER.md`.
