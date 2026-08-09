# landonkea-slack-tidyup — Design & Workflow

## High-Level Overview

```mermaid
graph TB
    subgraph "landonkea-slack-tidyup"
        A[delete.sh] --> B[AppleScript]
        A --> C[Chrome JavaScript]
        D[delete.js] --> E[Node.js]
        E --> B
        E --> C
    end

    subgraph "Chrome Integration"
        B --> F[osascript]
        C --> G[Slack Web App]
        G --> H[localStorage]
        H --> I[Slack Token]
    end

    I --> J[Slack API]
    J --> K[GET /channels.history]
    J --> L[DELETE /chat.delete]
    J --> M[GET /conversations.replies]
```

## Token Extraction Flow

```mermaid
sequenceDiagram
    participant S as Script
    participant A as AppleScript
    participant C as Chrome
    participant Sf as Slack Web App
    participant L as localStorage

    S->>A: Execute JS in Chrome
    A->>C: Run JavaScript
    C->>Sf: Access Slack page
    Sf->>L: Read localConfig_v2
    L-->>C: Slack token
    C-->>A: Token string
    A-->>S: Token ready
```

## Message Deletion Flow

```mermaid
flowchart TD
    A[Start] --> B[Get Slack token]
    B --> C[Fetch channel history]
    C --> D{More messages?}
    D -->|Yes| E[Filter by user ID]
    E --> F{Age filter?}
    F -->|Pass| G[Delete message]
    F -->|Fail| H[Skip]
    G --> I{Has thread replies?}
    I -->|Yes| J[Delete thread replies]
    I -->|No| D
    J --> D
    H --> D
    D -->|No| K[Done]
```

## File Relationships

| File | Purpose | Dependencies |
|------|---------|--------------|
| `delete.sh` | Bash + AppleScript version | macOS, Chrome |
| `delete.js` | Node.js version | macOS, Chrome, Node.js |
| `.env` | User ID config | `delete.sh`, `delete.js` |
| `.env.example` | Template | User setup |

## draw.io

[Open in draw.io](https://app.diagrams.net/#RSlack%20message%20deletion%20flow)
