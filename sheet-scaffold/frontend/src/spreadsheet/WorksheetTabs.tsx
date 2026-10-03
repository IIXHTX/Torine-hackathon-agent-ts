export interface WorksheetTabsProps {
  sheets: string[];
  active: string;
  onSelect?: (name: string) => void;
}

// Tests assert aria-selected="true" on exactly the active sheet's tab.
export function WorksheetTabs({ sheets, active, onSelect }: WorksheetTabsProps) {
  return (
    <div role="tablist" className="worksheet-tabs">
      {sheets.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={name === active ? "true" : "false"}
          className="worksheet-tab"
          onClick={() => onSelect?.(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
