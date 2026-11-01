// @vitest-environment node
import {
  createElement,
  type ElementType,
  type ReactElement,
} from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { PortalHost } from "@rn-primitives/portal";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { IssueActionsMenu } from "./issue-actions-menu";

vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Dimensions: {
    get: vi.fn(() => ({ width: 400, height: 800 })),
  },
  Platform: {
    OS: "android",
    select: (options: Record<string, unknown>) =>
      options.android ?? options.native ?? options.default,
  },
  Pressable: "Pressable",
  Text: "NativeText",
  View: "View",
}));
vi.mock("@/components/ui/icon-button", () => ({ IconButton: "IconButton" }));
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));
// react-test-renderer's host-name type only lists browser intrinsic elements.
const iconButtonType = "IconButton" as ElementType;
const nativeTextType = "NativeText" as ElementType;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface MenuProps extends MenuHandlers {
  isPinned: boolean;
  hasWebLink: boolean;
}
interface MenuHandlers {
  onPin: Mock;
  onUnpin: Mock;
  onEdit: Mock;
  onCopyLink: Mock;
  onOpenWeb: Mock;
  onDelete: Mock;
}

function createHandlers(): MenuHandlers {
  return {
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onEdit: vi.fn(),
    onCopyLink: vi.fn(),
    onOpenWeb: vi.fn(),
    onDelete: vi.fn(),
  };
}

function textContent(item: ReactTestInstance): string {
  const content = item.findByType(nativeTextType).props.children;
  if (typeof content !== "string") {
    throw new TypeError("Expected one text label");
  }
  return content;
}

function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByProps({ role: "menuitem" }).map(textContent);
}

async function openMenu(renderer: ReactTestRenderer) {
  await act(() => {
    renderer.root.findByType(iconButtonType).props.onPress({});
  });
  return renderer.root.findAllByProps({ role: "menu" });
}

async function pressItem(renderer: ReactTestRenderer, label: string) {
  const item = renderer.root
    .findAllByProps({ role: "menuitem" })
    .find((candidate) => textContent(candidate) === label);
  expect(item, `missing ${label}`).toBeDefined();
  await act(() => {
    item!.props.onPress({});
  });
}

function createNodeMock(element: ReactElement) {
  if (element.type === iconButtonType) {
    return {
      measure: (
        callback: (
          x: number,
          y: number,
          width: number,
          height: number,
          pageX: number,
          pageY: number,
        ) => void,
      ) => callback(0, 0, 40, 40, 320, 24),
    };
  }
  return {};
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function createMenuRenderer(props: MenuProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(() => {
    renderer = create(
      createElement(
        "Root",
        null,
        createElement(IssueActionsMenu, props),
        createElement(PortalHost),
      ),
      { createNodeMock },
    );
  });
  if (!renderer) throw new Error("Issue actions menu did not render");
  return renderer;
}

describe("IssueActionsMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens repeatedly on Android, dismisses, and runs every available action", async () => {
    const callbacks = createHandlers();
    const props = {
      ...callbacks,
      isPinned: false,
      hasWebLink: true,
    };
    let renderer = await createMenuRenderer(props);

    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
    expect(await openMenu(renderer)).toHaveLength(1);
    expect(labels(renderer)).toEqual([
      "menu.pin",
      "menu.edit_details",
      "menu.copy_link",
      "menu.open_web",
      "menu.delete_issue",
    ]);

    const expectedActions = [
      ["menu.pin", callbacks.onPin],
      ["menu.edit_details", callbacks.onEdit],
      ["menu.copy_link", callbacks.onCopyLink],
      ["menu.open_web", callbacks.onOpenWeb],
      ["menu.delete_issue", callbacks.onDelete],
    ] as const;

    for (const [label, callback] of expectedActions) {
      await pressItem(renderer, label);
      expect(callback).toHaveBeenCalledOnce();
      expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
      expect(await openMenu(renderer)).toHaveLength(1);
    }

    await act(() => {
      renderer.root.findByType(iconButtonType).props.onPress({});
    });
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);

    await act(() => renderer.unmount());
    renderer = await createMenuRenderer(props);
    expect(renderer.root.findAllByProps({ role: "menu" })).toHaveLength(0);
    expect(await openMenu(renderer)).toHaveLength(1);
    await act(() => renderer.unmount());
  });

  it("shows current-user pin state and omits web actions without a web URL", async () => {
    const callbacks = createHandlers();
    const renderer = await createMenuRenderer({
      ...callbacks,
      isPinned: true,
      hasWebLink: false,
    });

    expect(await openMenu(renderer)).toHaveLength(1);
    expect(labels(renderer)).toEqual([
      "menu.unpin",
      "menu.edit_details",
      "menu.delete_issue",
    ]);
    await pressItem(renderer, "menu.unpin");
    expect(callbacks.onUnpin).toHaveBeenCalledOnce();
    expect(callbacks.onPin).not.toHaveBeenCalled();
    await act(() => renderer.unmount());
  });
});
