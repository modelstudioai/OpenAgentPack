# HTML Report Format

The architectural review is rendered as a single HTML file in the OS temp directory. The report must open reliably for users on mainland China networks. Do not depend on Tailwind's runtime CDN or foreign CDNs for styling; inline the CSS you use. Mermaid may be loaded from a China-accessible CDN with a fallback, but hand-built divs and inline SVG must carry enough of the report that it still reads well if Mermaid fails.

Visible prose defaults to Simplified Chinese. Keep code identifiers, file paths, package names, and glossary terms readable; translate labels and explanations.

## Scaffold

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>架构评审 — {{repo name}}</title>
    <script>
      function initMermaid() {
        if (!window.mermaid) return;
        window.mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
      }
    </script>
    <script
      src="https://cdn.bootcdn.net/ajax/libs/mermaid/11.4.1/mermaid.min.js"
      onload="initMermaid()"
      onerror="this.onerror=null;this.onload=initMermaid;this.src='https://registry.npmmirror.com/mermaid/11.4.1/files/dist/mermaid.min.js'"
    ></script>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #fafaf9; color: #0f172a; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { max-width: 72rem; margin: 0 auto; padding: 2.5rem 1.5rem; }
      article { border: 1px solid #e2e8f0; border-radius: .5rem; background: #fff; padding: 1.5rem; box-shadow: 0 1px 2px rgba(15, 23, 42, .08); }
      .label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: #111827; color: white; }
      .module { border: 1px solid #cbd5e1; background: #fff; border-radius: .5rem; }
      .badge-strong { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    </style>
  </head>
  <body>
    <main>
      <header>...</header>
      <section id="candidates">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## Header

Repo name, date, and a compact Chinese legend: solid box = 模块, dashed line = 接缝, red arrow = 泄漏, thick dark box = 深模块. No introduction paragraph — straight into the candidates.

## Candidate card

The diagrams carry the weight. Prose is sparse, plain, and uses the glossary terms (from the `/codebase-design` skill) without ceremony.

Each candidate is one `<article>`:

- **Title** — short, in Chinese, names the deepening (e.g. "收拢 Order intake 流程").
- **Badge row** — recommendation strength (`强烈推荐` = emerald, `值得探索` = amber, `推测性` = slate), plus a translated tag for the dependency category (`进程内`, `本地可替换`, `端口与适配器`, `测试替身`).
- **Files** — monospaced list, `font-mono text-sm`.
- **当前 / 深化后 diagram** — the centrepiece. Two columns, side by side. See patterns below.
- **问题** — one sentence. What hurts.
- **方案** — one sentence. What changes.
- **收益** — bullets, short and concrete. e.g. "locality: bug 集中", "leverage: 一个 interface", "删除 4 个 shallow module".
- **ADR callout** (if applicable) — one line in an amber-tinted box.

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the diagram.

## Diagram patterns

Pick the pattern that fits the candidate. Mix them. Don't make every diagram look the same — variety is part of the point.

### Mermaid graph (the workhorse for dependencies / call flow)

Use a Mermaid `flowchart` or `graph` when the point is "X calls Y calls Z, and look at the mess." Wrap it in an inline-CSS card so it doesn't feel parachuted in. Style with classDef to colour leakage edges red and the deep module dark. Sequence diagrams work well for "当前：6 次往返；深化后：1 次。"

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.泄漏.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### Hand-built boxes-and-arrows (when Mermaid's layout fights you)

Modules as `<div>`s with borders and labels. Arrows as inline SVG `<line>` or `<path>` elements positioned absolutely over a relative container. Reach for this when you want the "after" diagram to feel like one thick-bordered deep module with greyed-out internals — Mermaid won't render that with the right weight.

### Cross-section (good for layered shallowness)

Stack horizontal bands (`h-12 border-l-4`) to show layers a call passes through. Before: 6 thin layers each doing nothing. After: 1 thick band labelled with the consolidated responsibility.

### Mass diagram (good for "interface as wide as implementation")

Two rectangles per module — one for interface surface area, one for implementation. Before: interface rectangle is nearly as tall as the implementation rectangle (shallow). After: interface rectangle is short, implementation rectangle is tall (deep).

### Call-graph collapse

Before: a tree of function calls rendered as nested boxes. After: the same tree collapsed into one box, with the now-internal calls shown faded inside it.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace. Serif optional for headings (`font-serif` works well with stone/slate).
- Colour sparingly: one accent (emerald or indigo) plus red for leakage and amber for warnings.
- Keep diagrams ~320px tall so before/after sits comfortably side by side without scrolling.
- Use `text-xs uppercase tracking-wider` for module labels inside diagrams — they should read as schematic, not as UI.
- The only external script allowed is Mermaid from the domestic CDN plus npm mirror fallback. No Tailwind runtime CDN. No app code, no interactivity beyond Mermaid's own rendering.
- Before finishing, search the HTML for `cdn.tailwindcss.com`, `jsdelivr`, `unpkg`, and `cdnjs`; none should remain.

## 首要建议 section

One larger card. Chinese heading `首要建议`, candidate name, one sentence on why, anchor link to its card. That's it.

## Tone

Plain Chinese, concise — but the architectural nouns and verbs come straight from the `/codebase-design` skill. Concision is not an excuse to drift. Prefer Chinese labels, but keep the vocabulary terms in English when precision matters: **module**, **interface**, **implementation**, **depth**, **deep**, **shallow**, **seam**, **adapter**, **leverage**, **locality**.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module 很 shallow — interface 几乎等于 implementation。"
- "Pricing 跨 seam 泄漏。"
- "深化：一个 interface，一个测试位置。"
- "两个 adapter 证明 seam 成立：生产 HTTP，测试内存。"

**收益 bullets** name the gain in glossary terms: *"locality: bug 集中在一个 module"*, *"leverage: 一个 interface，N 个调用点"*, *"interface 变小；implementation 吸收浅层 module"*. Don't write *"更容易维护"* or *"代码更干净"* — those terms aren't in the glossary and don't earn their place.

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet, make it a bullet. If a bullet could be cut, cut it. If a term isn't in the `/codebase-design` glossary, reach for one that is before inventing a new one.
