# AGENTS.md

How AI agents are used on this project. Read CLAUDE.md first. The first draft of this file invented roles, tools, and an `@agent` protocol that do not exist; it was replaced.

## Agent types available (as configured in this environment)

| Agent | Mode | Use for | Never use for |
|---|---|---|---|
| `scout` | read-only | codebase mapping, source discovery, first-pass regulatory/competitor research | edits; final regulatory facts without second-pass verification |
| `task` | read/write | implementing one well-scoped slice end to end | open-ended design with competing owners |
| `reviewer` | read-only | PR-style review of a diff against Rules.md | writing code |
| `security-reviewer` | read-only | authn/z, tenant isolation, crypto, replication-role grants, supply chain | functional bugs |
| `sonic` | low-reasoning | mechanical edits (renames, boilerplate with a given template), data collection | anything involving judgement, schemas, legal text |

The parent session (you) owns the plan, the contracts between slices, integration, and the final verification. Delegation never transfers accountability.

## Project responsibilities (roles, not agents)

| Responsibility | Typically done by | Path ownership |
|---|---|---|
| Architecture / ADRs | parent + user | `Architecture.md`, `docs/adr/` |
| Rust backend | `task` | `crates/recon-*` (one owner per crate at a time) |
| Database / replication / migrations | `task` + `security-reviewer` | `migrations/`, `DatabaseInfo.md`, role grants |
| Frontend | `task` | `frontend/` |
| Rule packs / regulatory content | `task` drafts, **human compliance owner approves** | `rules/`, `docs/privacy/` (CODEOWNERS-gated) |
| CI / infra | `task` | `.github/`, `infra/` |
| Research | `scout`, then verifier pass | `docs/Research.md` |

## Delegation rules

1. **Contract first.** Before fan-out, write the interface (SQL, Rust trait/type, OpenAPI fragment) into the task `context`. Children do not invent shared contracts.
2. **One integration owner** for any shared file; parallel slices touch disjoint paths.
3. **Self-contained tasks.** Children have no conversation history: give target files, non-goals, exact behaviour, acceptance check.
4. **No mid-flight build/lint/test by children** when multiple slices are in flight; the parent runs them once after integration.
5. **Parent verifies.** A child's "completed" is a claim. Run the code path, read the diff.
6. **Specify the solution space** honestly (fixed fix vs. open design) so the child does not over- or under-reach.

## Regulatory-research protocol (mandatory)

Why: the first scout report mis-dated ViDA, KSeF, VeriFactu and DAC7, misfiled DAC7 under the VAT Directive, and cited a cash-register scheme as e-invoicing (Research.md §1).

1. Scout produces candidates with URLs.
2. A *different* agent or the parent re-checks every date, article number, instrument number, and threshold against **EUR-Lex or the authority's own page**. Secondary sources (law firms, vendor blogs) may corroborate, not establish.
3. Each fact in Research.md gets a tag: **V** verified, **S** scout-reported, **K** prior knowledge, **X** wrong. Only **V** may enter rule packs or customer-facing text.
4. Absolutes ("no vendor does X", "zero competitors") are rejected unless the evidence is an exhaustive, dated search.
5. Anything entering `rules/` needs a human compliance approver (CODEOWNERS), not only an agent.

## Output standard for any delegated task

1. **Outcome** — what changed, 2–3 sentences.
2. **Artifacts** — paths touched.
3. **Verification** — the command run and its observed result (not "should work").
4. **Decisions** — non-obvious choices and why.
5. **Open risks / unverified claims** — explicit.

## Prompts

Agent behaviour baselines live in `SystemMasterPrompt.md`. Add task-specific instructions in the task text; do not fork the master prompt.

## Changing this file

Edit via PR; keep it limited to roles that actually exist in the tooling in use. If tooling changes, update the table in the same PR.
