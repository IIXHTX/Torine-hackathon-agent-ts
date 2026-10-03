import { useEffect, useState } from "react";

export interface FormulaBarProps {
  /** Raw formula for the selected cell (or its plain text value). */
  value: string;
  onCommit?: (value: string) => void;
}

// Tests address this input as getByLabel('Formula bar'): keep the label
// element wired to the input. Enter commits the edit.
export function FormulaBar({ value, onCommit }: FormulaBarProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="formula-bar">
      <label htmlFor="formula-bar-input" className="formula-bar__label">
        Formula bar
      </label>
      <input
        id="formula-bar-input"
        type="text"
        className="formula-bar__input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit?.(draft);
          }
        }}
      />
    </div>
  );
}
