// @vitest-environment jsdom

/**
 * Semantic adapter re-anchoring (issue #1732).
 *
 * The adapter's first pass stamps whole trees, but a rule can key on an
 * ANCESTOR of the node that arrives: the plugin sidebar row is recognised by
 * the glyph inside it, and the shell mounts the row before the registering
 * plugin paints that glyph. This spec pins both late-arrival orders, so a row
 * is never left unanchored until something forces a full pass.
 */

import { describe, expect, it } from 'vitest'

import { createSemanticAdapter, SEMANTIC_RULES_V1 } from '../src/client/runtime/semantic-adapter.ts'

/** One observer callback turn. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('semantic adapter late anchors (issue #1732)', () => {
  it('a plugin row mounted before its glyph is anchored when the glyph arrives', async () => {
    // Given a shell panel row whose glyph slot is still empty
    document.body.innerHTML = '<nav class="shell_panelList_hash">'
      + '<button class="shell_panelRow_hash"><span class="shell_panelGlyph_hash"></span></button></nav>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    const row = document.querySelector('[class*="panelRow"]')!
    expect(row.getAttribute('data-dsh-part'), 'the empty row has no glyph yet').toBeNull()

    // When the registering plugin paints its glyph inside that row
    const glyph = document.createElement('svg')
    glyph.setAttribute('data-dsh-panel-entry', 'task-board')
    row.querySelector('span')!.appendChild(glyph)
    await settle()

    // Then the row is a sidebar entry without any full pass having run
    expect(row.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    adapter.stop()
  })

  it('a glyph anchor set on an existing node re-anchors its row', async () => {
    // Given a row carrying a glyph element that has no anchor yet
    document.body.innerHTML = '<nav class="shell_panelList_hash">'
      + '<button class="shell_panelRow_hash"><span class="shell_panelGlyph_hash"><svg></svg></span></button></nav>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    const row = document.querySelector('[class*="panelRow"]')!
    const glyph = row.querySelector('svg')!
    expect(row.getAttribute('data-dsh-part'), 'an unmarked glyph marks nothing').toBeNull()

    // When a re-render flips the anchor attribute instead of replacing the node
    glyph.setAttribute('data-dsh-panel-entry', 'ssh')
    await settle()

    // Then the ancestor row is re-evaluated exactly like a newly inserted one
    expect(row.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    adapter.stop()
  })

  it('a symbol mounted inside a component re-anchors the component itself', async () => {
    // Given a mounted plugin panel that has not painted its own root anchor yet
    document.body.innerHTML = '<div class="host_centerCol_hash"><section class="ssh_shell_hash"></section></div>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    const shell = document.querySelector('[class*="ssh_shell"]')!
    expect(shell.getAttribute('data-dsh-plugin')).toBeNull()

    // When the panel paints its stable root anchor inside itself
    const view = document.createElement('div')
    view.setAttribute('data-dsh-ssh-view', '')
    shell.appendChild(view)
    await settle()

    // Then the ordinary descendant rule still lands (the ancestor walk does
    // not replace applyToTree, it complements it)
    expect(view.getAttribute('data-dsh-plugin')).toBe('ssh')
    adapter.stop()
  })

  it('anchors a row whose glyph sits deep inside a wrapper chain', async () => {
    // Given a panel row whose glyph is wrapped by several layout divs
    // (the shell's own row is three hops deep; deeper markup must not become a
    // cliff, which is exactly the defect this walk exists to fix)
    const wrappers = 12
    document.body.innerHTML = '<nav class="shell_panelList_hash">'
      + '<button class="shell_panelRow_hash"><span class="shell_panelGlyph_hash"></span></button></nav>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    const row = document.querySelector('[class*="panelRow"]')!

    // When the glyph arrives at the bottom of a nested wrapper chain
    let host: Element = row.querySelector('span')!
    for (let i = 0; i < wrappers; i += 1) {
      const wrapper = document.createElement('div')
      host.appendChild(wrapper)
      host = wrapper
    }
    const glyph = document.createElement('svg')
    glyph.setAttribute('data-dsh-panel-entry', 'task-board')
    host.appendChild(glyph)
    await settle()

    // Then the row is still anchored (spare depth is left by design)
    expect(row.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    adapter.stop()
  })

  it('stopping the adapter leaves no observer behind for late anchors', async () => {
    // Given a stopped adapter
    document.body.innerHTML = '<nav class="shell_panelList_hash">'
      + '<button class="shell_panelRow_hash"><span class="shell_panelGlyph_hash"></span></button></nav>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    adapter.stop()
    const row = document.querySelector('[class*="panelRow"]')!

    // When a glyph arrives after the stop
    const glyph = document.createElement('svg')
    glyph.setAttribute('data-dsh-panel-entry', 'task-board')
    row.querySelector('span')!.appendChild(glyph)
    await settle()

    // Then nothing stamps it
    expect(row.getAttribute('data-dsh-part')).toBeNull()
  })
})

describe('semantic adapter diagnostics counters', () => {
  it('counts the elements a rule tagged and remembers that it matched', async () => {
    // Given a shell fragment carrying two of the rule table's anchors
    document.body.innerHTML = '<div data-slot="root"></div><div data-turn-tail></div>'
    const adapter = createSemanticAdapter(document)
    adapter.start()

    // When the counters are read
    const diagnostics = adapter.diagnostics()
    const bySelector = (selector: string) =>
      diagnostics.rules.find((rule) => rule.selector === selector)!

    // Then a matched rule reports its sticky match and one tagged element
    expect(bySelector('[data-slot="root"]').everMatched).toBe(true)
    expect(bySelector('[data-slot="root"]').tagged).toBe(1)
    expect(bySelector('[data-turn-tail]').everMatched).toBe(true)
    expect(bySelector('[data-turn-tail]').tagged).toBe(1)
    // And every rule carries its audit note, so the health surface can name why
    expect(bySelector('[data-turn-tail]').note).not.toBe('')
    adapter.stop()
  })

  it('reports a rule that has never matched', async () => {
    // Given a shell fragment without the turn-tail anchor
    document.body.innerHTML = '<div data-slot="root"></div>'
    const adapter = createSemanticAdapter(document)
    adapter.start()

    // When the counters are read
    const diagnostics = adapter.diagnostics()
    const tail = diagnostics.rules.find((rule) => rule.selector === '[data-turn-tail]')!

    // Then the never-matched rule is distinguishable from the matched one
    expect(tail.everMatched).toBe(false)
    expect(tail.tagged).toBe(0)
    expect(tail.usable).toBe(true)
    expect(diagnostics.unmatchedRules).toContain('[data-turn-tail]')
    expect(diagnostics.unmatchedRules).not.toContain('[data-slot="root"]')
    expect(diagnostics.rules).toHaveLength(SEMANTIC_RULES_V1.length)
    adapter.stop()
  })

  it('does not inflate the tagged count when an element is delivered again', async () => {
    // Given one element the adapter has already stamped
    document.body.innerHTML = '<div id="host"></div>'
    const adapter = createSemanticAdapter(document)
    adapter.start()
    const row = document.createElement('div')
    row.setAttribute('data-turn-tail', '')
    document.getElementById('host')!.appendChild(row)
    await settle()

    // When a later attribute record re-anchors the same node
    row.setAttribute('data-decoration', 'chip')
    await settle()

    // Then the element is counted once, not once per delivery
    const tail = adapter.diagnostics().rules.find((rule) => rule.selector === '[data-turn-tail]')!
    expect(tail.tagged).toBe(1)
    expect(tail.everMatched).toBe(true)
    adapter.stop()
  })
})
