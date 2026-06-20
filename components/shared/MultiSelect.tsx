"use client";
import { useEffect, useRef, useState } from "react";

/** Compact multi-select dropdown with All/None controls (shared across lead views). */
export default function MultiSelect({
  placeholder,
  options,
  selected,
  onChange,
  className,
}: {
  placeholder: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const displayLabel =
    selected.length === 0
      ? placeholder
      : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-left hover:border-slate-400"
      >
        <span className={selected.length === 0 ? "text-slate-500 truncate" : "text-slate-800 truncate"}>{displayLabel}</span>
        <span className="shrink-0 text-slate-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-72 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 flex gap-3 px-3 py-2 bg-white border-b border-slate-100 text-xs">
            <button type="button" onClick={() => onChange(options.map((o) => o.value))} className="accent font-semibold hover:underline">All</button>
            <span className="text-slate-300">·</span>
            <button type="button" onClick={() => onChange([])} className="text-slate-500 hover:underline">None</button>
            {selected.length > 0 && <span className="ml-auto text-slate-400">{selected.length} of {options.length}</span>}
          </div>
          {options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={(e) => onChange(e.target.checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value))}
                className="accent-[var(--brand-accent)] shrink-0"
              />
              <span className="text-sm text-slate-700 truncate">{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
