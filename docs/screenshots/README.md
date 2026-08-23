# Delivery Screenshots

Generate screenshots with a healthy demo stack:

```bash
npm run screenshots
```

The script captures:

- `review-workspace.png`: document review with field confidence and highlighted source area.
- `execution-log.png`: failed execution details, stack, and retry action.
- `evaluation-report.png`: the committed evaluation report.

It uses the system Chrome and does not download a browser. Seed at least one `needs_review` document and one failed stage before capture.
