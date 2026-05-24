---
name: d2-diagrams
description: Create, validate, and render D2 diagrams for system architecture, data flow, infrastructure, service maps, and deployment diagrams. Use when Codex is asked to create or edit .d2 files, generate SVG/PNG diagrams from D2, validate D2 syntax, or produce readable architecture diagrams with containers, layers, arrows, caching, fallback paths, and observability.
---

# D2 Diagrams

## Workflow

1. Create diagrams as `.d2` source files in the requested docs or architecture directory.
2. Prefer `direction: right` for production architecture diagrams unless the user requests another layout.
3. Group related nodes into D2 containers such as client, edge, realtime path, agent mesh, data, cache, observability, and deployment.
4. Use concise node labels and labeled arrows for the major data flows.
5. Keep diagrams modular: route most fan-out through buses, gateways, queues, or orchestrators instead of drawing every possible direct dependency.
6. Show important fallback paths explicitly with labels such as `fallback`, `timeout`, `cached answer`, or `DLQ`.
7. Show cache reads and writes separately when latency is a key requirement.
8. Validate syntax by running `d2 input.d2 output.svg` before delivery whenever the D2 CLI is available.
9. If `d2` is missing and installation is acceptable for the task, install it with the local package manager, then render and validate.

## Production Diagram Guidelines

- Put the main happy path near the top or center.
- Put async improvement, analytics, and batch jobs below the real-time path.
- Put persistence, cache, and observability in separate containers.
- Label service replicas when redundancy matters.
- Label queues, streams, and event logs as the boundary between real-time and asynchronous work.
- Avoid dense cross-links. Prefer one arrow from a service to a container when the individual internal dependency is less important than the layer boundary.
- For voice-agent systems, separate the live media path from slower evaluation, reflection, memory updates, and dashboard analytics.

## Render Commands

Use:

```bash
d2 docs/architecture/name.d2 docs/architecture/name.svg
```

For syntax validation without keeping a render, use a temporary output:

```bash
d2 docs/architecture/name.d2 /tmp/name.svg
```
