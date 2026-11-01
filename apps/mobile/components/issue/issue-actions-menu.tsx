import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/i18n";

interface IssueActionsMenuProps {
  isPinned: boolean;
  hasWebLink: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onEdit: () => void;
  onCopyLink: () => void;
  onOpenWeb: () => void;
  onDelete: () => void;
}

/**
 * Cross-platform issue actions menu.
 *
 * The dropdown primitive owns one portal per mounted menu, closes items and
 * outside presses by default, and handles Android's hardware back button.
 */
export function IssueActionsMenu({
  isPinned,
  hasWebLink,
  onPin,
  onUnpin,
  onEdit,
  onCopyLink,
  onOpenWeb,
  onDelete,
}: IssueActionsMenuProps) {
  const { t } = useT("issues");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          name="ellipsis-horizontal"
          accessibilityLabel={t("menu.issue_actions")}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-56">
        <DropdownMenuItem onPress={isPinned ? onUnpin : onPin}>
          <Text>{t(isPinned ? "menu.unpin" : "menu.pin")}</Text>
        </DropdownMenuItem>
        <DropdownMenuItem onPress={onEdit}>
          <Text>{t("menu.edit_details")}</Text>
        </DropdownMenuItem>
        {hasWebLink ? (
          <>
            <DropdownMenuItem onPress={onCopyLink}>
              <Text>{t("menu.copy_link")}</Text>
            </DropdownMenuItem>
            <DropdownMenuItem onPress={onOpenWeb}>
              <Text>{t("menu.open_web")}</Text>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onPress={onDelete}>
          <Text>{t("menu.delete_issue")}</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
