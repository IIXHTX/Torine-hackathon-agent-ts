import { useMemo } from "react";

export type CellValue = { display: string; formula?: string };

export interface SpreadsheetGridProps {
  /** All coordinates to render, e.g. ["A1", "B1", "A2", "B2"]. */
  coordinates: string[];
  cells: Record<string, CellValue>;
  selected: Record<string, true>;
  onSelect?: (coord: string, event: { shiftKey: boolean }) => void;
  onCommit?: (coord: string, value: string) => void;
}

function rowOf(coord: string): number {
  return Number(coord.replace(/^[A-Z]+/, "")) || 0;
}

function colOf(coord: string): string {
  return coord.replace(/\d+$/, "");
}

// ARIA grid: role=grid > role=row > role=gridcell with aria-label = coordinate.
// Cell text is the DISPLAYED value (computed result for formula cells).
export function SpreadsheetGrid({ coordinates, cells, selected, onSelect }: SpreadsheetGridProps) {
  const rows = useMemo(() => {
    const byRow = new Map<number, string[]>();
    for (const coord of coordinates) {
      const r = rowOf(coord);
      byRow.set(r, [...(byRow.get(r) ?? []), coord]);
    }
    return [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cols]) => cols.sort((a, b) => colOf(a).localeCompare(colOf(b))));
  }, [coordinates]);

  return (
    <table role="grid" aria-multiselectable="true">
      <tbody>
        {rows.map((cols, rowIndex) => (
          <tr role="row" key={rowIndex}>
            {cols.map((coord) => (
              <td
                key={coord}
                role="gridcell"
                aria-label={coord}
                aria-selected={selected[coord] ? "true" : "false"}
                tabIndex={0}
                onClick={(event) => onSelect?.(coord, { shiftKey: event.shiftKey })}
                className="spreadsheet-cell"
              >
                {cells[coord]?.display ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
