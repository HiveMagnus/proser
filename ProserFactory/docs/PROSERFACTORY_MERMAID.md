# ProserFactory workflow v1

```mermaid
flowchart LR
  Hermes[Hermes tools] --> API[Express workflow API]
  Author[ProserAuthor Book Factory] --> API
  API --> DB[(PostgreSQL)]
  API --> Queue[BullMQ book-workflow-v1]
  Queue --> Worker[proser-worker]
  Worker --> Model[Model router]
  Worker --> DB
  Worker --> Revision[Immutable manuscript revisions]
  Worker --> Review[Quality review and findings]
  Worker --> Package[Validated publication package]

  Full[Full Book] --> ReviewChild[Quality Review child]
  ReviewChild --> ImproveChild[Improve Quality child]
  ImproveChild --> VerifyChild[Verification Review child]
  Full --> Package
  Review --> Findings[Per-model findings]
  Findings --> Improve[Improve Quality]
  Guided[Guided Improve] --> Revision
```

All four workflow types share the queue, tasks, events, heartbeat, retries, checkpoints, revision ancestry, and audit trail. Full Book is the only parent workflow and invokes its editorial workflows as visible children.
