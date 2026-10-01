/**
 * Semantic adapter (issue #506, contract section 6, L2 compat adapter).
 *
 * One merged MutationObserver that stamps the semantic-attribute enumeration
 * (contracts/semantic-attrs-v1.md) onto the official shell DOM and onto
 * plugin roots that already expose stable anchors. This is explicitly a
 * COMPAT adapter — not a permanent public contract:
 *  - official areas migrate to first-party attributes when the upstream
 *    theme seam lands (then these rules are re-evaluated for deletion);
 *  - third-party plugin areas stay here long-term (plugins that opt in
 *    output the attributes themselves and the adapter becomes a no-op).
 *
 * Properties:
 *  - merged: a single observer handles every rule;
 *  - idempotent: re-tagging an already-correct element is a no-op, so React
 *    re-renders simply get re-stamped when their nodes are re-added;
 *  - fail-closed diagnostics: rules that match nothing and selectors the
 *    engine rejects are reported, never thrown into the page;
 *  - the adapter never REMOVES attributes it did not set; disposal only
 *    disconnects the observer (stamping is cosmetic and scopes itself under
 *    html[data-dsh-skin] consumers).
 * @module @linxin666/dsh-client-ui-skin-center/runtime/semantic-adapter
 */

export type SemanticAttr = 'data-dsh-surface' | 'data-dsh-part' | 'data-dsh-plugin'

export interface SemanticRule {
  /** CSS selector matched against added/existing elements. */
  selector: string
  /** Attribute(s) applied on match. */
  attrs: readonly (readonly [SemanticAttr, string])[]
  /** Why this rule exists / what it anchors (audit trail). */
  note: string
}

/**
 * The v1 rule table. Single ownership: only the skin-center edits this.
 * Anchors verified against @deepseek-ai rc.7 (see docs/archive survey).
 */
export const SEMANTIC_RULES_V1: readonly SemanticRule[] = [
  // ---- surfaces (official shell) ----
  { selector: '[data-slot="root"]', attrs: [['data-dsh-surface', 'root']], note: 'ui-renderer root outlet' },
  { selector: '[data-slot="sidebar"]', attrs: [['data-dsh-surface', 'sidebar']], note: 'layout sidebar outlet' },
  {
    selector: '[data-slot="conversation"], [class*="centerCol"]',
    attrs: [['data-dsh-surface', 'conversation']],
    note: 'conversation column: legacy conversation outlet; since dsh 0.1.7 the column carries no data hook, so the css-module suffix (hash prefix varies, suffix stable) is the anchor',
  },
  { selector: '[data-slot="conversation.session.header"]', attrs: [['data-dsh-surface', 'session-header']], note: 'conversation header outlet' },
  { selector: '[data-slot="conversation.composer"]', attrs: [['data-dsh-surface', 'composer']], note: 'composer chain outlet' },
  {
    selector: '[data-slot="details"], [data-rightbar-col]',
    attrs: [['data-dsh-surface', 'details']],
    note: 'details column: legacy details outlet; since dsh 0.1.7 the right sidebar column carries the official data-rightbar-col hook (0-width while collapsed, so stamping it paints nothing when closed)',
  },
  { selector: '[data-shell-overlay]', attrs: [['data-dsh-surface', 'overlay']], note: 'frame overlay attribute' },
  { selector: '[data-slot="shell.overlay"]', attrs: [['data-dsh-surface', 'overlay']], note: 'shell overlay outlet' },
  {
    selector: '[role="dialog"]:has([data-slot="settings.section"])',
    attrs: [['data-dsh-surface', 'settings']],
    note: 'settings dialog (composite: dialog containing the section outlet)',
  },
  // ---- shell parts ----
  { selector: '[data-chat-flow-kind]', attrs: [['data-dsh-part', 'message-row']], note: 'chat flow item' },
  { selector: '[data-streaming]', attrs: [['data-dsh-part', 'message-body']], note: 'assistant markdown root' },
  { selector: '[data-conversation-scroll]', attrs: [['data-dsh-part', 'scrollport']], note: 'conversation scrollport' },
  {
    selector: 'textarea[data-phase], [data-composer-input]',
    attrs: [['data-dsh-part', 'composer-input']],
    note: 'composer input: legacy textarea; current shells render a Lexical contenteditable carrying data-composer-input',
  },
  { selector: '[data-decoration="chip"]', attrs: [['data-dsh-part', 'composer-chip']], note: 'composer reference chip' },
  { selector: '[data-queue-dock]', attrs: [['data-dsh-part', 'queue-dock']], note: 'queued turns dock' },
  { selector: '[data-turn-tail]', attrs: [['data-dsh-part', 'turn-tail']], note: 'turn tail row' },
  { selector: '[data-side]', attrs: [['data-dsh-part', 'resize-handle']], note: 'column resize handle' },
  {
    selector: 'button[class*="newSession"]',
    attrs: [['data-dsh-part', 'new-session']],
    note: 'sidebar new-session action (compat seam shields skins from localized labels)',
  },
  // ---- plugin roots (plugins without stable anchors opt in via AGENTS.md) ----
  {
    selector: '[data-dsh-taskboard-view], [data-dsh-taskboard-board]',
    attrs: [['data-dsh-plugin', 'task-board']],
    note: 'task-board panel/board (the sidebar row is shell-owned: its glyph carries data-dsh-panel-entry and the family rule below stamps the row)',
  },
  {
    selector: '[data-dsh-ssh-view]',
    attrs: [['data-dsh-plugin', 'ssh']],
    note: 'ssh panel (the sidebar row is shell-owned: its glyph carries data-dsh-panel-entry and the family rule below stamps the row)',
  },
  {
    selector: '[data-gitgraph-chip-anchor], [data-gitgraph-dialog]',
    attrs: [['data-dsh-plugin', 'git-graph']],
    note: 'git-graph chip/dialog',
  },
  {
    selector: '[data-dsh-pet-root]',
    attrs: [['data-dsh-plugin', 'pet']],
    note: 'pet global root',
  },
  // ---- family parts ----
  {
    selector: '[class*="panelRow"]:has([data-dsh-panel-entry])',
    attrs: [['data-dsh-part', 'sidebar-entry']],
    note: 'a plugin-registered sidebar row (sidebar.panellist): the shell owns the row box and stamps no hook of its own, so the row is recognised by its css-module class plus the glyph identity the registering plugin outputs — same compat technique as newSession',
  },
]

/**
 * The anchors the rule table keys on, as one attribute filter for the
 * observer: a glyph or row anchor that is SET on an element already in the
 * tree must re-anchor its ancestors exactly like a newly inserted one.
 */
const ANCHOR_ATTRIBUTES: readonly string[] = [
  'data-dsh-panel-entry',
  'data-dsh-surface',
  'data-dsh-part',
  'data-dsh-plugin',
  'data-slot',
  'data-chat-flow-kind',
  'data-conversation-scroll',
  'data-turn-tail',
  'data-composer-input',
  'data-queue-dock',
  'data-rightbar-col',
  'data-shell-overlay',
  'data-dsh-taskboard-view',
  'data-dsh-taskboard-board',
  'data-dsh-ssh-view',
  'data-dsh-pet-root',
  'data-gitgraph-chip-anchor',
  'data-gitgraph-dialog',
  'data-decoration',
  'data-streaming',
  'data-side',
  'data-phase',
]
// 'class' is deliberately absent: React sets className when it creates the
// element, so a row whose class matters already carries it when the childList
// record arrives, and class toggles are by far the most frequent attribute
// traffic on the page. The filter stays on identity anchors.

/**
 * Safety bound of the ancestor walk, NOT a depth ceiling.
 *
 * The walk's normal terminator is the observed root: every node the observer
 * can report is inside document.body, so the walk returns there (measured —
 * with this bound removed the walk still stops at body on every delivery).
 * This constant only fires for a change inside a subtree that is not connected
 * to the observed root at all, where there is no ancestor to anchor yet and
 * the node's own childList delivery stamps it once it IS attached.
 *
 * It is deliberately far above any real markup depth (the shell's own sidebar
 * row is three hops deep) instead of a small number that would silently leave
 * a deeper row unanchored — which is the very defect this walk exists to fix
 * (issue #1732). A measured sweep anchors through 23 wrapper levels and misses
 * from 24, i.e. only past the point where the tree is pathological.
 */
const ANCESTOR_HOPS = 24

export interface SemanticAdapterDiagnostics {
  /** Rules whose selector the engine rejects (dropped, never retried). */
  invalidRules: string[]
  /** Rules that matched zero elements in the latest full pass. */
  unmatchedRules: string[]
  /** Total attributes stamped since start. */
  stamped: number
}

export interface SemanticAdapter {
  start(): void
  stop(): void
  diagnostics(): SemanticAdapterDiagnostics
  readonly running: boolean
}

interface LiveRule {
  rule: SemanticRule
  /** False once the engine rejected the selector. */
  usable: boolean
  /** Elements matched in the latest full pass. */
  matchedInPass: number
}

export function createSemanticAdapter(doc: Document): SemanticAdapter {
  const rules: LiveRule[] = SEMANTIC_RULES_V1.map((rule) => ({ rule, usable: true, matchedInPass: 0 }))
  let observer: MutationObserver | null = null
  let stamped = 0
  let running = false

  const applyRule = (live: LiveRule, el: Element): void => {
    if (!live.usable) return
    let hit = false
    try {
      hit = el.matches(live.rule.selector)
    } catch {
      live.usable = false
      return
    }
    if (!hit) return
    live.matchedInPass += 1
    for (const [name, value] of live.rule.attrs) {
      if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value)
        stamped += 1
      }
    }
  }

  const applyToTree = (rootEl: Element): void => {
    for (const live of rules) {
      if (!live.usable) continue
      applyRule(live, rootEl)
      let matches: Element[] = []
      try {
        matches = Array.from(rootEl.querySelectorAll(live.rule.selector))
      } catch {
        live.usable = false
        continue
      }
      for (const el of matches) applyRule(live, el)
    }
  }

  const fullPass = (): void => {
    for (const live of rules) live.matchedInPass = 0
    if (doc.documentElement) applyToTree(doc.documentElement)
  }

  /**
   * Re-anchor one changed node and its ancestor chain.
   *
   * applyToTree only walks DOWNWARD: a rule whose selector matches an ancestor
   * of the changed node (the panel-list row is recognised by the glyph INSIDE
   * it) is never re-evaluated when that descendant arrives. React mounts the
   * row first and the registering plugin's glyph a tick later, so without this
   * the row keeps no anchor at all until something forces a full pass
   * (issue #1732). The walk is bounded and stops at the document root.
   */
  const reanchorAround = (node: Element): void => {
    const root = doc.body ?? doc.documentElement
    let current: Element | null = node
    for (let hop = 0; current !== null && hop <= ANCESTOR_HOPS; hop += 1) {
      for (const live of rules) {
        if (live.usable) applyRule(live, current)
      }
      // Stop at the observed root: going further cannot reach a node the
      // observer is even watching, and body is the ceiling it was given.
      if (current === root || current === doc.documentElement) return
      current = current.parentElement
    }
  }

  return {
    get running() {
      return running
    },

    start() {
      if (running) return
      running = true
      fullPass()
      observer = new doc.defaultView!.MutationObserver((records) => {
        try {
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (node.nodeType !== 1) continue
              const el = node as Element
              applyToTree(el)
              // The added subtree may itself be the glyph a row wants; the row
              // is an ANCESTOR of it and applyToTree never looks up (#1732).
              reanchorAround(el.parentElement ?? el)
            }
            // A glyph whose ANCHOR is set on an element already in the tree
            // (a re-render that flips the attribute instead of replacing the
            // node) is the same signal, and childList alone never sees it.
            const target = record.target.nodeType === 1 ? record.target as Element : null
            if (target !== null && record.type === 'attributes') reanchorAround(target)
          }
        } catch {
          // Fail-closed: a tagging error must never break the host page.
        }
      })
      observer.observe(doc.body ?? doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [...ANCHOR_ATTRIBUTES],
      })
    },

    stop() {
      running = false
      observer?.disconnect()
      observer = null
    },

    diagnostics() {
      return {
        invalidRules: rules.filter((r) => !r.usable).map((r) => r.rule.selector),
        unmatchedRules: rules.filter((r) => r.usable && r.matchedInPass === 0).map((r) => r.rule.selector),
        stamped,
      }
    },
  }
}
