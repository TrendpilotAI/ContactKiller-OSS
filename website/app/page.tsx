const repositoryUrl =
  process.env.NEXT_PUBLIC_REPOSITORY_URL ??
  "https://github.com/TrendpilotAI/ContactKiller-OSS";

interface SourceRecord {
  source: string;
  state: "Conflict" | "Partial";
  detail: string;
}

const sourceRecords: SourceRecord[] = [
  { source: "iCloud", state: "Conflict", detail: "name · phone" },
  { source: "Personal Google", state: "Conflict", detail: "email · phone" },
  { source: "Work Google", state: "Partial", detail: "name · email" },
  { source: "CRM evidence", state: "Conflict", detail: "role · company" },
];

const principles = [
  {
    number: "01",
    title: "Preserve every observation",
    body: "Keep source payloads, account aliases, hashes, and timestamps before deciding what any field means.",
  },
  {
    number: "02",
    title: "Resolve conservatively",
    body: "Exact normalized identifiers may support a proposal. A similar name never silently merges two people.",
  },
  {
    number: "03",
    title: "Approve every write",
    body: "Merge, archive, delete, and publish plans remain unapplied until a human approves a bounded mutation.",
  },
];

const architecture = [
  {
    id: "A",
    title: "Observe",
    body: "Capture immutable evidence and its source boundary.",
  },
  {
    id: "B",
    title: "Normalize",
    body: "Parse fields without erasing their provenance.",
  },
  {
    id: "C",
    title: "Propose",
    body: "Build a replayable canonical projection.",
  },
  {
    id: "D",
    title: "Review",
    body: "Fork, compare, and approve a change plan.",
  },
  {
    id: "E",
    title: "Write",
    body: "Execute a small, reversible provider mutation.",
  },
];

const statusColumns = [
  {
    label: "Available now",
    tone: "available",
    items: [
      ["Contact explorer", "SurrealDB-backed prototype"],
      ["Google Contacts", "Read-only one-way import"],
      ["iCloud", "Manual vCard import"],
      ["Mesh", "Bounded read-only research path"],
      ["DuckDB", "Disposable forensic cache"],
      ["ActiveGraph", "Typed domain foundation"],
    ],
  },
  {
    label: "Active development",
    tone: "development",
    items: [
      ["SurrealDB", "Canonical persistence cutover"],
      ["Provider safety", "Approval and mutation execution"],
      ["Conflict engine", "Complete review generation"],
    ],
  },
  {
    label: "Community extensions",
    tone: "community",
    items: [
      ["FalkorDB", "Disposable graph projection"],
      ["Source adapters", "Read-only provider evidence"],
      ["Benchmarks", "Synthetic replay scenarios"],
    ],
  },
];

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      className="button-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.69-1.29-1.69-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.3-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.06.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" viewBox="0 0 24 24">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" className="lock-icon" viewBox="0 0 24 24">
      <rect x="5" y="10" width="14" height="11" rx="1" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <span>C</span>
      <span>K</span>
    </span>
  );
}

export default function HomePage() {
  return (
    <main>
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="ContactKiller home">
          <LogoMark />
          <span>ContactKiller</span>
        </a>

        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#why">Why it exists</a>
          <a href="#architecture">Architecture</a>
          <a href="#status">Status</a>
          <a href="#ecosystem">Ecosystem</a>
        </nav>

        <a
          className="button button-primary header-action"
          href={repositoryUrl}
          rel="noreferrer"
          target="_blank"
        >
          <GitHubMark />
          <span className="header-action-label">Explore the code</span>
          <span className="mobile-action-label">GitHub</span>
        </a>
      </header>

      <div className="brass-rule" aria-hidden="true">
        <span />
        <span />
      </div>

      <section id="top" className="hero" aria-labelledby="hero-title">
        <div className="hero-copy" id="content">
          <h1 id="hero-title">
            Your address books disagree. <em>ContactKiller</em> shows its work.
          </h1>
          <p className="hero-lede">
            ContactKiller is being built to preserve evidence, resolve identities
            conservatively, and preview cleanup before touching a provider.
          </p>
          <div className="hero-actions">
            <a
              className="button button-primary"
              href={repositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitHubMark />
              Explore the code
            </a>
            <a className="button button-secondary" href="#why">
              Trace the evidence
              <ArrowIcon />
            </a>
          </div>
          <p className="hero-license">Apache-2.0 · experimental · human-gated</p>
        </div>

        <div className="machine-shell" aria-label="A synthetic reconciliation example">
          <div className="machine-image" aria-hidden="true" />

          <div className="source-stack">
            {sourceRecords.map((record) => (
              <article className="source-record" key={record.source}>
                <div className="source-name">{record.source}</div>
                <div className={`evidence-slip state-${record.state.toLowerCase()}`}>
                  <strong>{record.state}</strong>
                  <span>{record.detail}</span>
                </div>
              </article>
            ))}
          </div>

          <article className="identity-docket">
            <h2>Maya Chen</h2>
            <p className="synthetic-label">Synthetic person</p>
            <dl>
              <div>
                <dt>Name</dt>
                <dd>Maya Chen</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>Provenance attached</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>Conflict retained</dd>
              </div>
            </dl>
          </article>

          <div className="write-gate">
            <span>Provider write</span>
            <strong>
              <LockIcon /> Locked
            </strong>
            <small>Proposed · not applied</small>
          </div>

          <p className="machine-caption">
            Reconciliation, not synchronization.
          </p>
        </div>
      </section>

      <section className="principles" aria-label="ContactKiller principles">
        {principles.map((principle) => (
          <article key={principle.number}>
            <span className="principle-number">{principle.number}</span>
            <h2>{principle.title}</h2>
            <p>{principle.body}</p>
          </article>
        ))}
      </section>

      <section id="why" className="challenge section-pad" aria-labelledby="challenge-title">
        <div className="section-intro">
          <p className="section-index">01 / The challenge</p>
          <h2 id="challenge-title">An address book is a distributed system in disguise.</h2>
        </div>

        <div className="challenge-body">
          <p className="lead-paragraph">
            One person can exist as an iCloud card, two Google records, a CRM
            lead, and a bare phone number in a messaging app. Each source may be
            locally correct—and collectively contradictory.
          </p>
          <div className="tension-grid">
            <article>
              <p className="mono-label bad-label">Synchronization asks</p>
              <h3>Which copy should win?</h3>
              <p>
                The answer is often an overwrite. Missing context becomes
                deletion, and account boundaries disappear.
              </p>
            </article>
            <div className="tension-symbol" aria-hidden="true">≠</div>
            <article>
              <p className="mono-label good-label">Reconciliation asks</p>
              <h3>What does each source know?</h3>
              <p>
                The target workflow preserves observations, explains a proposed
                identity, and makes the write boundary visible.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section id="architecture" className="architecture section-pad" aria-labelledby="architecture-title">
        <div className="architecture-heading">
          <div>
            <p className="section-index light">02 / The method</p>
            <h2 id="architecture-title">A decision system with a memory.</h2>
          </div>
          <p>
            ContactKiller is being built so canonical contacts become projections
            of evidence and decisions—not overwritten source records. The target
            workflow makes proposals replayable, forkable, and comparable before
            an external write.
          </p>
        </div>

        <ol className="architecture-flow">
          {architecture.map((step) => (
            <li key={step.id}>
              <span>{step.id}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="control-panel">
          <div className="control-display">
            <span className="signal-dot" aria-hidden="true" />
            <p>Proposed change plan</p>
            <strong>Awaiting human review</strong>
          </div>
          <div className="control-details">
            <span>Replayable</span>
            <span>Account-scoped</span>
            <span>Bounded</span>
          </div>
          <div className="control-lock">
            <LockIcon />
            External write disabled
          </div>
        </div>
      </section>

      <section id="status" className="status section-pad" aria-labelledby="status-title">
        <div className="section-intro split-intro">
          <div>
            <p className="section-index">03 / Honest status</p>
            <h2 id="status-title">Useful now. Candid about what is next.</h2>
          </div>
          <p>
            “Available” means code exists on the default branch. It does not
            mean production-proven, write-safe, or ready for personal contact
            exports.
          </p>
        </div>

        <div className="status-board">
          {statusColumns.map((column) => (
            <article className={`status-column ${column.tone}`} key={column.label}>
              <header>
                <span className="status-light" aria-hidden="true" />
                <h3>{column.label}</h3>
              </header>
              <ul>
                {column.items.map(([title, detail]) => (
                  <li key={title}>
                    <strong>{title}</strong>
                    <span>{detail}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="truth-strip" role="note" aria-label="Current limitations">
          <strong>No implied integrations:</strong>
          <span>No WhatsApp adapter</span>
          <span>No live CRM connectors</span>
          <span>No production-safe bulk mutations</span>
        </div>
      </section>

      <section id="ecosystem" className="ecosystem section-pad" aria-labelledby="ecosystem-title">
        <div className="section-intro ecosystem-intro">
          <p className="section-index light">04 / Ecosystem</p>
          <h2 id="ecosystem-title">One source of truth. Several deliberate seams.</h2>
          <p>
            ContactKiller owns reconciliation behavior. Optional engines keep
            their own jobs—and their own licenses.
          </p>
        </div>

        <div className="ecosystem-grid">
          <article>
            <span className="engine-glyph surreal" aria-hidden="true">S</span>
            <p className="mono-label">Canonical persistence · in development</p>
            <h3>SurrealDB</h3>
            <p>
              Experimental persistence boundary for observations, records,
              operations, and graph relations.
            </p>
            <small>Upstream server: Business Source License 1.1</small>
          </article>
          <article>
            <span className="engine-glyph active" aria-hidden="true">A</span>
            <p className="mono-label">Typed behavior · foundation available</p>
            <h3>ActiveGraph</h3>
            <p>
              Tasks, approval routing, event history, replay, and fork/diff
              experiments around the reconciliation model.
            </p>
            <small>Upstream: Apache License 2.0</small>
          </article>
          <article>
            <span className="engine-glyph falkor" aria-hidden="true">F</span>
            <p className="mono-label">Disposable projection · community RFC</p>
            <h3>FalkorDB</h3>
            <p>
              A proposed projection seam for graph exploration and benchmarks,
              never a competing system of record.
            </p>
            <small>Upstream: source-available terms; consult its license</small>
          </article>
        </div>

        <p className="license-boundary">
          The Apache-2.0 license covers original ContactKiller work. It does not
          relicense optional databases, services, or dependencies.
        </p>
      </section>

      <section className="open-source section-pad" aria-labelledby="open-title">
        <div className="open-source-copy">
          <p className="section-index">05 / Open source</p>
          <h2 id="open-title">Bring a messy edge case. Leave a safer system.</h2>
          <p>
            ContactKiller is open for read-only adapters, synthetic failure
            cases, identity rules, replay benchmarks, graph projections, and
            stronger write gates. The hard parts belong in the open.
          </p>
          <div className="hero-actions">
            <a
              className="button button-primary"
              href={repositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitHubMark />
              Explore the repository
            </a>
            <a
              className="button button-secondary dark-button"
              href={`${repositoryUrl}/blob/main/CONTRIBUTING.md`}
              rel="noreferrer"
              target="_blank"
            >
              Read the contributor guide
            </a>
          </div>
        </div>

        <aside className="contribution-docket" aria-label="Good first contributions">
          <div className="docket-clip" aria-hidden="true" />
          <p className="mono-label">Good first contributions</p>
          <ul>
            <li><span>01</span> Read-only source adapters</li>
            <li><span>02</span> Synthetic duplicate scenarios</li>
            <li><span>03</span> Deterministic identity rules</li>
            <li><span>04</span> Replay and isolation tests</li>
            <li><span>05</span> Disposable graph projections</li>
          </ul>
          <p className="docket-license">Licensed Apache-2.0</p>
        </aside>
      </section>

      <section className="safety" aria-labelledby="safety-title">
        <div className="safety-symbol" aria-hidden="true">
          <LockIcon />
        </div>
        <div>
          <p className="mono-label">Safety boundary</p>
          <h2 id="safety-title">Experimental software. Real contact books stay out.</h2>
          <p>
            ContactKiller is not a production-safe bulk deletion tool. Develop
            with synthetic people and development tenants. Never point an
            unreviewed build at a real address book, CRM, or messaging account.
          </p>
        </div>
      </section>

      <footer>
        <div className="footer-brand">
          <LogoMark />
          <div>
            <strong>ContactKiller</strong>
            <span>Kill contact chaos. Keep every relationship.</span>
          </div>
        </div>
        <nav aria-label="Footer navigation">
          <a href={repositoryUrl} rel="noreferrer" target="_blank">GitHub</a>
          <a href={`${repositoryUrl}/blob/main/ROADMAP.md`} rel="noreferrer" target="_blank">Roadmap</a>
          <a href={`${repositoryUrl}/blob/main/SECURITY.md`} rel="noreferrer" target="_blank">Security</a>
          <a href={`${repositoryUrl}/blob/main/LICENSE`} rel="noreferrer" target="_blank">Apache-2.0</a>
        </nav>
        <p>Prepared for public release. No real contact data shown.</p>
      </footer>
    </main>
  );
}
