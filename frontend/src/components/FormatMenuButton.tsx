import { Button, ListItemText, Menu, MenuItem } from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { useState } from "react";
import type { OutputFormat } from "../formats";

interface Props {
  /// Button label, e.g. "复制" or "下载".
  label: string;
  /// Leading icon.
  icon: React.ReactNode;
  /// MUI button variant.
  variant?: "text" | "outlined" | "contained";
  size?: "small" | "medium";
  disabled?: boolean;
  /// Called with the chosen format when a menu item is selected.
  onPick: (format: OutputFormat) => void;
}

const OPTIONS: { format: OutputFormat; label: string; hint: string }[] = [
  { format: "cpa", label: "CPA 格式", hint: "cockpit-tools / CLIProxyAPI" },
  { format: "sub2api", label: "Sub2API 格式", hint: "Sub2API 导出结构" },
];

/// A button that opens a small menu to pick an output format (CPA / Sub2API)
/// before performing copy or download. Reused across result and split views.
export function FormatMenuButton({
  label,
  icon,
  variant = "outlined",
  size = "small",
  disabled,
  onPick,
}: Props) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const open = Boolean(anchor);

  const pick = (format: OutputFormat) => {
    setAnchor(null);
    onPick(format);
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        startIcon={icon}
        endIcon={<ArrowDropDownIcon />}
        disabled={disabled}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        {label}
      </Button>
      <Menu anchorEl={anchor} open={open} onClose={() => setAnchor(null)}>
        {OPTIONS.map((opt) => (
          <MenuItem key={opt.format} onClick={() => pick(opt.format)}>
            <ListItemText primary={opt.label} secondary={opt.hint} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
