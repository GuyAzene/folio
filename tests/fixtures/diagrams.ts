/**
 * Synthetic Mermaid diagrams of the kinds a tutor draws, for comparing renderers and for tests.
 * None comes from course material. `unsafe` ones carry markup a renderer must not let through.
 */
export interface DiagramFixture {
  name: string;
  source: string;
  unsafe?: boolean;
  /** Expected to fail to parse. */
  invalid?: boolean;
}

function chain(count: number): string {
  const lines = ["flowchart LR"];
  for (let index = 1; index < count; index++)
    lines.push(`  n${index}[Step ${index}] --> n${index + 1}[Step ${index + 1}]`);
  for (let index = 1; index + 7 < count; index += 7) lines.push(`  n${index} -.-> n${index + 7}`);
  return lines.join("\n");
}

export const DIAGRAMS: DiagramFixture[] = [
  {
    name: "Automaton with an ε move and a self-loop",
    source: `flowchart LR
  start(( )) --> q0((q0))
  q0 -->|a| q1((q1))
  q1 -->|a| q1
  q1 -->|b| q2(((q2)))
  q0 -->|ε| q2
  q2 -->|a, b| q0`,
  },
  {
    name: "Algorithm steps",
    source: `flowchart TD
  A[Put s in the queue and mark it] --> B{Is the queue empty?}
  B -->|yes| E[Done]
  B -->|no| C[Take the first vertex u]
  C --> D[For each unmarked neighbour v:<br/>mark v, set dist v = dist u + 1, enqueue v]
  D --> B`,
  },
  {
    name: "Sequence: a three-way handshake",
    source: `sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: SYN (seq = x)
  S->>C: SYN-ACK (seq = y, ack = x + 1)
  C->>S: ACK (ack = y + 1)
  Note over C,S: The connection is open`,
  },
  {
    name: "Class diagram",
    source: `classDiagram
  class Graph {
    +List~Vertex~ vertices
    +addEdge(u, v)
    +neighbours(v) List~Vertex~
  }
  class Vertex {
    +int id
    +bool marked
  }
  class Edge {
    +Vertex from
    +Vertex to
    +int weight
  }
  Graph "1" *-- "many" Vertex
  Graph "1" *-- "many" Edge`,
  },
  {
    name: "Entity relationships",
    source: `erDiagram
  STUDENT ||--o{ ENROLLMENT : has
  COURSE ||--o{ ENROLLMENT : includes
  STUDENT {
    int id PK
    string name
  }
  COURSE {
    string code PK
    string title
  }
  ENROLLMENT {
    int student FK
    string course FK
    string grade
  }`,
  },
  {
    name: "Process states",
    source: `stateDiagram-v2
  [*] --> Ready
  Ready --> Running: scheduled
  Running --> Ready: time slice ends
  Running --> Waiting: waits for I/O
  Waiting --> Ready: I/O done
  Running --> [*]: exits`,
  },
  {
    name: "Mind map",
    source: `mindmap
  root((Graph search))
    Breadth-first
      Layers
      Shortest paths in edges
    Depth-first
      Discovery and finish times
      Topological order
    Weighted
      Dijkstra
      Bellman-Ford`,
  },
  {
    name: "Chart: running times",
    source: `xychart-beta
  title "Steps for n items"
  x-axis [8, 16, 32, 64, 128]
  y-axis "Steps" 0 --> 700
  line [24, 64, 160, 384, 896]
  bar [8, 16, 32, 64, 128]`,
  },
  {
    name: "Hebrew labels",
    source: `flowchart TD
  A[התחלה: גרף G וקודקוד s] --> B{האם התור ריק?}
  B -->|כן| C[סיום]
  B -->|לא| D[הוצא את u מהתור]
  D --> E[סמן כל שכן v שלא סומן]
  E --> B`,
  },
  {
    name: "Mixed Hebrew and English labels",
    source: `flowchart LR
  A[אלגוריתם Dijkstra] -->|משקלים אי-שליליים| B[מרחקים קצרים ביותר]
  A -->|negative weights| C[Bellman-Ford במקום]
  B --> D[O of E log V עם ערימה]`,
  },
  {
    name: "Timeline",
    source: `timeline
  title A course in four weeks
  Week 1 : Graphs : Breadth-first search
  Week 2 : Depth-first search
  Week 3 : Shortest paths
  Week 4 : Spanning trees`,
  },
  { name: "Fifty steps", source: chain(50) },
  {
    name: "A syntax error",
    invalid: true,
    source: `flowchart LR
  A[Open --> B[Never closed`,
  },
  {
    name: "Unsafe: HTML in a sequence label",
    unsafe: true,
    source: `sequenceDiagram
  A->>B: <img src=x onerror="document.title='leaked'"> hello`,
  },
  {
    name: "Unsafe: a style that escapes its rule",
    unsafe: true,
    source: `flowchart LR
  A --> B
  classDef x fill:#fff} body{background:url(https://example.com/leak)
  class A x`,
  },
  {
    name: "Unsafe: a script link",
    unsafe: true,
    source: `flowchart LR
  A[Click me] --> B
  click A "javascript:document.title='leaked'"`,
  },
];
