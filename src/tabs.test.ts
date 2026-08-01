import { describe, expect, it, vi } from "vitest";
import type { EditorBuffer } from "./editor";
import { createSessionPersister } from "./sessionpersist";
import {
  canMutateDocument,
  closeSequentially,
  DRAG_THRESHOLD_PX,
  idsOtherThan,
  idsToTheRightOf,
  isEffectivelyReadOnly,
  TabStore,
  type Doc,
} from "./tabs";

function makeDoc(id: number, path: string | null = null): Doc {
  return {
    id,
    path,
    title: path ? (path.split("/").pop() ?? path) : `Untitled-${id}`,
    encoding: "UTF-8",
    withBom: false,
    lineEnding: "LF",
    malformed: false,
    dirty: false,
    revision: 0,
    truncated: false,
    userReadOnly: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    saveReloadInFlight: null,
    pendingReload: false,
    pendingSaveAs: null,
    speculativeEncoding: null,
    backupName: null,
    detectionHint: null,
    fingerprint: null,
    byteDriftChecked: false,
    buffer: {} as EditorBuffer,
  };
}

function makeStore() {
  const container = document.createElement("div");
  const events = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    onContextMenu: vi.fn(),
  };
  return { store: new TabStore(container, events), container, events };
}

/** Dispatch a full click gesture (pointerdown + pointerup, no movement) at
 *  `clientX` on `el`, matching how selection actually resolves (see
 *  tabs.ts's onTabPointerUp: a click-with-no-drag selects on release, not
 *  on press). `button` defaults to the primary button. */
function pointerClick(el: Element, clientX = 0, button = 0): void {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      button,
      pointerId: 1,
      clientX,
      bubbles: true,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointerup", { pointerId: 1, clientX, bubbles: true }),
  );
}

/** Stub a tab element's layout as a `width`-wide slot starting at `left`,
 *  since jsdom has no real layout engine and getBoundingClientRect()
 *  otherwise always reports all-zero rects — needed to exercise the
 *  drop-slot hit-testing in commitReorder deterministically. */
function stubRect(el: HTMLElement, left: number, width = 100): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left,
    width,
    right: left + width,
    top: 0,
    bottom: 0,
    height: 0,
    x: left,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect);
}

// ROADMAP.md v0.4 Track C per-tab read-only mode: truncated (large-file
// preview) read-only can never be lifted; userReadOnly is the user's own
// per-tab lock, layered independently on top of it. Exhaustive over the
// 2x2 combination table since this is the single formula every read-only
// enforcement/UI call site (editor.ts's setReadOnly, the View menu's
// checked/enabled state, the status bar badge, saveFlow/runLineOperation's
// guard) is built on.
describe("isEffectivelyReadOnly", () => {
  it("is false when neither truncated nor userReadOnly is set", () => {
    expect(isEffectivelyReadOnly({ truncated: false, userReadOnly: false })).toBe(false);
  });

  it("is true when only truncated is set", () => {
    expect(isEffectivelyReadOnly({ truncated: true, userReadOnly: false })).toBe(true);
  });

  it("is true when only userReadOnly is set", () => {
    expect(isEffectivelyReadOnly({ truncated: false, userReadOnly: true })).toBe(true);
  });

  it("is true when both truncated and userReadOnly are set", () => {
    expect(isEffectivelyReadOnly({ truncated: true, userReadOnly: true })).toBe(true);
  });
});

// ROADMAP.md D2, Codex re-review of PR #309: the update-install freeze's
// single collapse point (main.ts's blockedByReadOnly, guarding
// runLineOperation/saveFlow — the same call sites isEffectivelyReadOnly
// above already backs). Mirrors "insert_datetime / a line operation is
// blocked while frozen, and works again once unfrozen" at the pure-
// predicate level, since main.ts's own dispatch wiring isn't unit-testable
// (it's wired directly into IPC/DOM/editor — same reasoning as
// sessionpersist.ts's header comment).
describe("canMutateDocument", () => {
  const editableDoc = { truncated: false, userReadOnly: false };

  it("is true for an ordinary editable doc when not frozen", () => {
    expect(canMutateDocument(editableDoc, false)).toBe(true);
  });

  it("is false for the same doc while the update-install freeze is active — this is the case a raw dispatch (insert_datetime, a line operation) must not slip past", () => {
    expect(canMutateDocument(editableDoc, true)).toBe(false);
  });

  it("is true again for the same doc once the freeze is lifted", () => {
    expect(canMutateDocument(editableDoc, false)).toBe(true);
  });

  it("stays false while frozen even for a doc that would otherwise be mutable in every other respect", () => {
    // Redundant with the case above by construction, but pins the
    // intent explicitly: freeze is an unconditional AND, not something
    // any doc-level state can override.
    expect(canMutateDocument({ truncated: false, userReadOnly: false }, true)).toBe(false);
  });

  it("is false when the doc is already read-only, frozen or not", () => {
    expect(canMutateDocument({ truncated: true, userReadOnly: false }, false)).toBe(false);
    expect(canMutateDocument({ truncated: false, userReadOnly: true }, false)).toBe(false);
    expect(canMutateDocument({ truncated: true, userReadOnly: false }, true)).toBe(false);
    expect(canMutateDocument({ truncated: false, userReadOnly: true }, true)).toBe(false);
  });
});

// ROADMAP.md D2, Codex re-review (3rd round) of PR #309: an async flow
// that already passed its *own* entry guard before the freeze started
// (mojibake repair's wizard, Edit > Normalize's confirm/representability
// round trips) must re-check mutability again at its actual apply point —
// main.ts's showMojibakeRepairWizard now does this via blockedByReadOnly
// (which calls canMutateDocument), and runNormalizeFlow's
// normalizeGuardOutcome checks updateFreezeActive before every one of its
// three `editor.replaceContent` checkpoints, both funneling through this
// exact function. Narrated as the scenario the review flagged, even
// though mechanically identical to the cases above: the pure predicate is
// what's under test, since main.ts's own dispatch/dialog wiring isn't
// unit-testable (see sessionpersist.ts's header comment for why).
describe("canMutateDocument — async apply-after-freeze scenario", () => {
  const doc = { truncated: false, userReadOnly: false };

  it("an async flow that started while mutable is still blocked if the doc is frozen by the time its result is ready to apply", () => {
    // t0: the flow starts (e.g. showMojibakeRepairWizard/runNormalizeFlow
    // checks its entry guard) — mutation is allowed.
    const allowedAtStart = canMutateDocument(doc, false);
    expect(allowedAtStart).toBe(true);

    // t1: an update-install freeze begins while the flow's own async work
    // (wizard round trip, confirm dialog, checkRepresentable IPC) is still
    // in flight — nothing about `doc` itself changed.
    const frozenBeforeApply = true;

    // t2: the callback/apply point re-checks right before writing —
    // must now be blocked, regardless of the t0 snapshot.
    expect(canMutateDocument(doc, frozenBeforeApply)).toBe(false);
  });

  it("the same flow's apply point succeeds once the freeze has lifted", () => {
    expect(canMutateDocument(doc, false)).toBe(true);
  });
});

// ROADMAP.md D2, Codex re-review (4th round) of PR #309: a third class of
// missed entry point, alongside the menu/palette-dispatch and async-apply
// ones the two describe blocks above cover — a synchronous status-bar
// picker (main.ts's setLineEnding, showEncodingMenu's "Save with
// Encoding") reached by a plain DOM click listener, never through the
// native menu or CM6 dispatch at all. Same underlying predicate, same
// reasoning as those two blocks for why the pure-logic layer is what's
// under test — see updateFreezeActive's own doc comment (main.ts) for the
// full entry-point audit this round performed.
describe("canMutateDocument — synchronous status-bar picker scenario", () => {
  const doc = { truncated: false, userReadOnly: false };

  it("a status-bar picker action (setLineEnding, Save with Encoding) is blocked while frozen, with no async gap involved at all", () => {
    expect(canMutateDocument(doc, true)).toBe(false);
  });

  it("the same picker action works again once unfrozen", () => {
    expect(canMutateDocument(doc, false)).toBe(true);
  });
});

describe("TabStore", () => {
  it("activates a doc when it is added", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    expect(store.activeId).toBe(2);
    expect(store.active?.id).toBe(2);
  });

  it("activates the right neighbor when the active tab closes", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2);
    store.close(2);
    expect(store.docs.map((d) => d.id)).toEqual([1, 3]);
    expect(store.activeId).toBe(3);
  });

  it("falls back to the left neighbor when the last tab closes", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.close(2);
    expect(store.activeId).toBe(1);
  });

  it("keeps the active tab when closing another tab", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.close(1);
    expect(store.activeId).toBe(2);
  });

  it("cycles through tabs with wrap-around", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.cycle(1);
    expect(store.activeId).toBe(1);
    store.cycle(-1);
    expect(store.activeId).toBe(3);
  });

  it("persisting right after a cycle snapshots the post-cycle active id", async () => {
    // The contract main.ts's cycleTab relies on (issue #304): persist()
    // collects synchronously at call time, so a persist fired after
    // tabs.cycle must capture the new active tab, not the pre-cycle one.
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    const saved: Array<number | null> = [];
    const persister = createSessionPersister({
      collect: () => store.activeId,
      save: (activeId) => {
        saved.push(activeId);
        return Promise.resolve();
      },
    });
    store.cycle(1);
    await persister.persist();
    expect(saved).toEqual([1]);
  });

  it("finds docs by path", () => {
    const { store } = makeStore();
    store.add(makeDoc(1, "/tmp/a.txt"));
    store.add(makeDoc(2, "/tmp/b.txt"));
    expect(store.findByPath("/tmp/a.txt")?.id).toBe(1);
    expect(store.findByPath("/tmp/missing.txt")).toBeNull();
  });

  it("renders tabs with dirty indicators and wires events", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1, "/tmp/a.txt"));
    store.add(makeDoc(2));
    store.docs[0].dirty = true;
    store.render();

    const tabs = container.querySelectorAll(".tab");
    expect(tabs.length).toBe(2);
    expect(tabs[1].classList.contains("active")).toBe(true);
    expect(tabs[0].querySelector(".tab-close")?.textContent).toBe("●");
    expect(tabs[1].querySelector(".tab-close")?.textContent).toBe("×");

    pointerClick(tabs[0]);
    expect(events.onSelect).toHaveBeenCalledWith(1);

    tabs[0]
      .querySelector(".tab-close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events.onClose).toHaveBeenCalledWith(1);

    container
      .querySelector(".tab-new")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events.onNew).toHaveBeenCalled();
  });

  it("right-click fires onContextMenu with the tab's own id and suppresses the native menu, without touching selection", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(event, "preventDefault");
    tabs[0].dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(events.onContextMenu).toHaveBeenCalledWith(1, tabs[0]);
    // contextmenu alone (no pointerdown/pointerup gesture) never resolves
    // a select or a reorder — those stay owned by the pointer state
    // machine, exercised separately in the drag-to-reorder suite below.
    expect(events.onSelect).not.toHaveBeenCalled();
    expect(events.onReorder).not.toHaveBeenCalled();
  });

  it("a right-click gesture (pointerdown+contextmenu+pointerup) both selects and opens the context menu, same as any non-primary-button click", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");

    // Mirrors a real right-click's event sequence: pointerdown arms the
    // (non-primary-button) gesture, contextmenu fires, then pointerup
    // resolves it — see beginTabDrag's primaryButton doc comment for why
    // a right-click's pointerup always resolves as a plain select.
    tabs[1].dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, pointerId: 1, clientX: 0, bubbles: true }),
    );
    tabs[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    tabs[1].dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 0, bubbles: true }));

    expect(events.onContextMenu).toHaveBeenCalledWith(2, tabs[1]);
    expect(events.onSelect).toHaveBeenCalledWith(2);
    expect(events.onReorder).not.toHaveBeenCalled();
  });
});

describe("TabStore.moveTab (pure reorder logic)", () => {
  it("moves a doc from the front to the back", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
  });

  it("moves a doc from the back to the front", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.moveTab(2, 0);
    expect(store.docs.map((d) => d.id)).toEqual([3, 1, 2]);
  });

  it("shifts only the tabs between the source and destination", () => {
    const { store } = makeStore();
    for (const id of [1, 2, 3, 4, 5]) store.add(makeDoc(id));
    store.moveTab(4, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 5, 2, 3, 4]);
  });

  it("is a no-op when fromIndex equals toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(1, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("is a no-op for a negative fromIndex or toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(-1, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    store.moveTab(0, -1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("is a no-op for an out-of-range fromIndex or toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(0, 5);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    store.moveTab(5, 0);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("leaves an empty or single-tab store untouched", () => {
    const { store } = makeStore();
    store.moveTab(0, 0);
    expect(store.docs).toEqual([]);
    store.add(makeDoc(1));
    store.moveTab(0, 0);
    expect(store.docs.map((d) => d.id)).toEqual([1]);
  });

  it("keeps activeId pointing at the same doc when a different tab moves around it", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2);
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(2);
  });

  it("keeps the moved tab active when the active tab itself is the one moved", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(1);
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(1);
  });
});

describe("TabStore pointer drag-to-reorder", () => {
  it("selects on a plain click (no movement) and does not reorder", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();

    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    pointerClick(tabs[0], 50);

    expect(events.onSelect).toHaveBeenCalledWith(1);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
  });

  it("does not enter dragging mode below the threshold, and still selects on release", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX - 1,
        bubbles: true,
      }),
    );
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX - 1,
        bubbles: true,
      }),
    );
    expect(events.onSelect).toHaveBeenCalledWith(1);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("enters dragging mode once past the threshold and applies visual feedback", () => {
    const { store, container } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX,
        bubbles: true,
      }),
    );

    expect(tabs[0].classList.contains("tab-dragging")).toBe(true);
    expect(tabs[0].style.transform).toBe(`translateX(${DRAG_THRESHOLD_PX}px)`);
  });

  it("never enters dragging mode for a middle or right-click, but still selects on release", () => {
    for (const button of [1, 2]) {
      const { store, container, events } = makeStore();
      store.add(makeDoc(1));
      store.add(makeDoc(2));
      store.render();
      const tabs = container.querySelectorAll<HTMLElement>(".tab");
      stubRect(tabs[0], 0);
      stubRect(tabs[1], 100);

      tabs[0].dispatchEvent(
        new PointerEvent("pointerdown", {
          button,
          pointerId: 1,
          clientX: 50,
          bubbles: true,
        }),
      );
      tabs[0].dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          clientX: 300, // far past the threshold
          bubbles: true,
        }),
      );
      expect(tabs[0].classList.contains("tab-dragging")).toBe(false);

      tabs[0].dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 1, clientX: 300, bubbles: true }),
      );
      expect(events.onSelect).toHaveBeenCalledWith(1);
      expect(events.onReorder).not.toHaveBeenCalled();
      expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    }
  });

  it("never arms a drag or selects from a pointerdown on the close button", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.render();
    const close = container.querySelector(".tab-close")!;

    close.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 0,
        bubbles: true,
      }),
    );
    close.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 300, bubbles: true }),
    );
    close.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 300, bubbles: true }),
    );

    expect(events.onSelect).not.toHaveBeenCalled();
    expect(events.onReorder).not.toHaveBeenCalled();
  });

  it("resets visual state without selecting or reordering on pointercancel", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 300, bubbles: true }),
    );
    expect(tabs[0].classList.contains("tab-dragging")).toBe(true);

    tabs[0].dispatchEvent(
      new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
    );

    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    expect(tabs[0].style.transform).toBe("");
    expect(events.onSelect).not.toHaveBeenCalled();
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("reorders end-to-end when dropped past a neighbor's midpoint, tracking activeId by id", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2); // active tab is not the one being dragged
    store.render();

    let tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0); // doc 1: [0, 100), center 50
    stubRect(tabs[1], 100); // doc 2: [100, 200), center 150
    stubRect(tabs[2], 200); // doc 3: [200, 300), center 250

    // Drag doc 1 from its own center (50) past both neighbors' centers.
    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 260, bubbles: true }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 260, bubbles: true }),
    );

    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(2); // unchanged: tracked by id, not index
    expect(events.onReorder).toHaveBeenCalledTimes(1);
    expect(events.onSelect).not.toHaveBeenCalled();

    // render() rebuilt the DOM; the old element is detached and no longer
    // carries the drag's leftover class/transform.
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    tabs = container.querySelectorAll<HTMLElement>(".tab");
    expect(tabs.length).toBe(3);
  });

  it("does not reorder or fire onReorder when dropped back on its own slot", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0); // doc 1: [0, 100), center 50
    stubRect(tabs[1], 100); // doc 2: [100, 200), center 150

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    // Move past the threshold, then back to (near) the start — still
    // short of doc 2's center (150), so the drop slot resolves to the
    // same index it started at.
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 70, bubbles: true }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 52, bubbles: true }),
    );

    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(events.onSelect).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    expect(tabs[0].style.transform).toBe("");
  });
});

// Tab context menu target-set math (ROADMAP.md Track C). Pure over a plain
// Doc[]/id — no TabStore/DOM needed, see tabs.ts's "Tab context menu
// helpers" section.
describe("idsOtherThan", () => {
  it("returns every other id, preserving tab order, excluding the given id", () => {
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3)];
    expect(idsOtherThan(docs, 2)).toEqual([1, 3]);
  });

  it("excludes the first and the last tab the same way as any middle one", () => {
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3)];
    expect(idsOtherThan(docs, 1)).toEqual([2, 3]);
    expect(idsOtherThan(docs, 3)).toEqual([1, 2]);
  });

  it("returns every id when the given id isn't present", () => {
    const docs = [makeDoc(1), makeDoc(2)];
    expect(idsOtherThan(docs, 999)).toEqual([1, 2]);
  });

  it("returns [] for a single-tab store (the lone tab excludes itself)", () => {
    expect(idsOtherThan([makeDoc(1)], 1)).toEqual([]);
  });

  it("returns [] for an empty store", () => {
    expect(idsOtherThan([], 1)).toEqual([]);
  });
});

describe("idsToTheRightOf", () => {
  it("returns only the ids strictly to the right, in order", () => {
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3), makeDoc(4)];
    expect(idsToTheRightOf(docs, 2)).toEqual([3, 4]);
  });

  it("returns every other id when given the leftmost tab", () => {
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3)];
    expect(idsToTheRightOf(docs, 1)).toEqual([2, 3]);
  });

  it("returns [] for the rightmost tab", () => {
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3)];
    expect(idsToTheRightOf(docs, 3)).toEqual([]);
  });

  it("returns [] when the given id isn't present (defensive)", () => {
    const docs = [makeDoc(1), makeDoc(2)];
    expect(idsToTheRightOf(docs, 999)).toEqual([]);
  });

  it("returns [] for a single-tab or empty store", () => {
    expect(idsToTheRightOf([makeDoc(1)], 1)).toEqual([]);
    expect(idsToTheRightOf([], 1)).toEqual([]);
  });
});

// Batch-close abort semantics (ROADMAP.md Track C): "any one cancel stops
// the rest of the batch." closeTab itself never throws on a cancelled
// close (it just leaves the doc in place) — see tabs.ts's closeSequentially
// doc comment — so these fakes model that exact contract: closeTab is a
// plain async no-throw function, and cancellation is only observable by
// asking stillOpen afterward.
describe("closeSequentially", () => {
  function fakeCloser(cancelOn: number[]) {
    const closed: number[] = [];
    const open = new Set<number>();
    const closeTab = vi.fn(async (id: number) => {
      if (cancelOn.includes(id)) {
        open.add(id); // "cancel": doc stays present, closeTab still resolves
        return;
      }
      closed.push(id);
      open.delete(id); // closed for real
    });
    const stillOpen = (id: number) => open.has(id);
    return { closeTab, stillOpen, closed };
  }

  it("closes every id in order when none are cancelled", async () => {
    const { closeTab, stillOpen, closed } = fakeCloser([]);
    await closeSequentially([1, 2, 3], closeTab, stillOpen);
    expect(closed).toEqual([1, 2, 3]);
    expect(closeTab).toHaveBeenCalledTimes(3);
  });

  it("stops immediately at the first cancelled id, never attempting the rest", async () => {
    const { closeTab, stillOpen, closed } = fakeCloser([2]);
    await closeSequentially([1, 2, 3], closeTab, stillOpen);
    expect(closed).toEqual([1]); // 2 cancelled; 3 never attempted
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).not.toHaveBeenCalledWith(3);
  });

  it("cancelling the very first id closes nothing", async () => {
    const { closeTab, stillOpen, closed } = fakeCloser([1]);
    await closeSequentially([1, 2, 3], closeTab, stillOpen);
    expect(closed).toEqual([]);
    expect(closeTab).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an empty id list", async () => {
    const { closeTab, stillOpen, closed } = fakeCloser([]);
    await closeSequentially([], closeTab, stillOpen);
    expect(closed).toEqual([]);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("awaits each closeTab before starting the next (true sequencing, not Promise.all)", async () => {
    const order: string[] = [];
    const resolvers: Array<() => void> = [];
    const closeTab = vi.fn(
      (id: number) =>
        new Promise<void>((resolve) => {
          order.push(`start:${id}`);
          resolvers.push(() => {
            order.push(`end:${id}`);
            resolve();
          });
        }),
    );
    const donePromise = closeSequentially([1, 2], closeTab, () => false);

    // Only the first call has fired; the second must not start until the
    // first's promise resolves.
    expect(order).toEqual(["start:1"]);
    resolvers[0]();
    await Promise.resolve(); // let the microtask queue drain one tick
    await Promise.resolve();
    expect(order).toEqual(["start:1", "end:1", "start:2"]);
    resolvers[1]();
    await donePromise;
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });
});
