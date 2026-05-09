import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  Search,
  X,
} from 'lucide-react';

const asNumberArray = (values = []) => values.map(Number).filter(Number.isFinite);

function SelectedChip({ label, onRemove }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800"
        title={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function CheckboxMark({ checked, partial = false }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked || partial
          ? 'border-blue-600 bg-blue-600 text-white'
          : 'border-slate-300 bg-white text-transparent group-hover:border-blue-400'
      }`}
    >
      {partial ? <span className="h-0.5 w-2 rounded-full bg-white" /> : <Check className="h-3 w-3" />}
    </span>
  );
}

export default function CanonicalCategoryFilter({
  categoryTree = [],
  selectedCategoryIds = [],
  selectedSubcategoryIds = [],
  onChange,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draftCategoryIds, setDraftCategoryIds] = useState(() => asNumberArray(selectedCategoryIds));
  const [draftSubcategoryIds, setDraftSubcategoryIds] = useState(() => asNumberArray(selectedSubcategoryIds));
  const [expandedCategoryIds, setExpandedCategoryIds] = useState(() => new Set());
  const ref = useRef(null);

  const normalizedCategoryIds = useMemo(() => asNumberArray(selectedCategoryIds), [selectedCategoryIds]);
  const normalizedSubcategoryIds = useMemo(() => asNumberArray(selectedSubcategoryIds), [selectedSubcategoryIds]);
  const selectedCount = normalizedCategoryIds.length + normalizedSubcategoryIds.length;
  const draftCount = draftCategoryIds.length + draftSubcategoryIds.length;

  const subcategoryToParent = useMemo(() => {
    const map = new Map();
    for (const category of categoryTree) {
      for (const subcategory of category.subcategories || []) {
        map.set(Number(subcategory.id), Number(category.id));
      }
    }
    return map;
  }, [categoryTree]);

  const draftLabels = useMemo(() => {
    const labels = [];
    const categorySet = new Set(draftCategoryIds);
    const subcategorySet = new Set(draftSubcategoryIds);
    for (const category of categoryTree) {
      if (categorySet.has(Number(category.id))) {
        labels.push({ id: `c-${category.id}`, type: 'category', value: Number(category.id), label: category.name });
      }
      for (const subcategory of category.subcategories || []) {
        if (subcategorySet.has(Number(subcategory.id))) {
          labels.push({
            id: `s-${subcategory.id}`,
            type: 'subcategory',
            value: Number(subcategory.id),
            label: `${category.name} / ${subcategory.name}`,
          });
        }
      }
    }
    return labels;
  }, [categoryTree, draftCategoryIds, draftSubcategoryIds]);

  const filteredTree = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return categoryTree;

    return categoryTree.flatMap((category) => {
      const categoryText = `${category.name || ''} ${category.description || ''}`.toLowerCase();
      const categoryMatches = categoryText.includes(query);
      const matchingSubcategories = (category.subcategories || []).filter((subcategory) => {
        const subcategoryText = `${subcategory.name || ''} ${subcategory.description || ''} ${category.name || ''}`.toLowerCase();
        return categoryMatches || subcategoryText.includes(query);
      });

      if (!categoryMatches && matchingSubcategories.length === 0) return [];
      return [{ ...category, subcategories: matchingSubcategories }];
    });
  }, [categoryTree, search]);

  useEffect(() => {
    const handler = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDraftCategoryIds(normalizedCategoryIds);
      setDraftSubcategoryIds(normalizedSubcategoryIds);
      setSearch('');
    }
  }, [normalizedCategoryIds, normalizedSubcategoryIds, open]);

  useEffect(() => {
    if (search.trim()) {
      setExpandedCategoryIds(new Set(filteredTree.map((category) => Number(category.id))));
    }
  }, [filteredTree, search]);

  const toggleOpen = () => {
    setOpen((value) => !value);
    if (!open) {
      setDraftCategoryIds(normalizedCategoryIds);
      setDraftSubcategoryIds(normalizedSubcategoryIds);
      const parentIds = new Set();
      for (const subcategoryId of normalizedSubcategoryIds) {
        const parentId = subcategoryToParent.get(Number(subcategoryId));
        if (parentId) parentIds.add(parentId);
      }
      setExpandedCategoryIds(parentIds);
    }
  };

  const commitSelection = ({ categoryIds = draftCategoryIds, subcategoryIds = draftSubcategoryIds }) => {
    const nextCategoryIds = asNumberArray(categoryIds);
    const nextSubcategoryIds = asNumberArray(subcategoryIds);
    setDraftCategoryIds(nextCategoryIds);
    setDraftSubcategoryIds(nextSubcategoryIds);
    onChange({ categoryIds: nextCategoryIds, subcategoryIds: nextSubcategoryIds });
  };

  const toggleCategory = (categoryId) => {
    const id = Number(categoryId);
    const category = categoryTree.find((item) => Number(item.id) === id);
    const childIds = new Set((category?.subcategories || []).map((subcategory) => Number(subcategory.id)));
    const nextCategoryIds = draftCategoryIds.includes(id)
      ? draftCategoryIds.filter((item) => item !== id)
      : [...draftCategoryIds, id];
    const nextSubcategoryIds = draftSubcategoryIds.filter((item) => !childIds.has(Number(item)));
    commitSelection({ categoryIds: nextCategoryIds, subcategoryIds: nextSubcategoryIds });
  };

  const toggleSubcategory = (subcategoryId) => {
    const id = Number(subcategoryId);
    const nextSubcategoryIds = draftSubcategoryIds.includes(id)
      ? draftSubcategoryIds.filter((item) => item !== id)
      : [...draftSubcategoryIds, id];
    commitSelection({ subcategoryIds: nextSubcategoryIds });
  };

  const chooseSubcategory = (subcategoryId, parentCategoryId) => {
    const id = Number(subcategoryId);
    const parentId = Number(parentCategoryId);
    if (draftCategoryIds.includes(parentId)) {
      commitSelection({
        categoryIds: draftCategoryIds.filter((item) => item !== parentId),
        subcategoryIds: draftSubcategoryIds.includes(id) ? draftSubcategoryIds : [...draftSubcategoryIds, id],
      });
      return;
    }
    toggleSubcategory(id);
  };

  const toggleExpanded = (categoryId) => {
    const id = Number(categoryId);
    setExpandedCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeDraftSelected = (item) => {
    if (item.type === 'category') {
      commitSelection({ categoryIds: draftCategoryIds.filter((id) => id !== item.value) });
      return;
    }
    commitSelection({ subcategoryIds: draftSubcategoryIds.filter((id) => id !== item.value) });
  };

  const clearDraft = () => {
    commitSelection({ categoryIds: [], subcategoryIds: [] });
  };

  return (
    <div className={`relative w-full sm:w-auto ${className}`} ref={ref}>
      <button
        type="button"
        onClick={toggleOpen}
        className={`group flex h-9 w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold shadow-sm transition-all sm:w-auto ${
          selectedCount
            ? 'border-blue-300 bg-blue-600 text-white shadow-blue-100 hover:bg-blue-700'
            : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700'
        } ${open ? 'ring-2 ring-blue-200' : ''}`}
        title={selectedCount ? `${selectedCount} category filter${selectedCount === 1 ? '' : 's'} selected` : 'Filter by category or subcategory'}
      >
        <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${selectedCount ? 'bg-white/20' : 'bg-blue-50 text-blue-600 group-hover:bg-blue-100'}`}>
          <Filter className="h-4 w-4" />
        </span>
        <span>Categories</span>
        {selectedCount > 0 && (
          <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-extrabold leading-none text-blue-700">
            {selectedCount}
          </span>
        )}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(70vh,34rem)] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">
          <div className="shrink-0 border-b border-slate-200 bg-slate-50/90 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                  <Filter className="h-4 w-4 text-blue-600" />
                  Categories
                  {draftCount > 0 && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-extrabold text-blue-700">{draftCount}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                title="Close category filters"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="relative mt-3 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search categories or subcategories"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-9 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title="Clear category search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>

            {draftLabels.length > 0 && (
              <div className="mt-3 flex items-center gap-1.5 overflow-hidden">
                {draftLabels.slice(0, 2).map((item) => (
                  <SelectedChip key={item.id} label={item.label} onRemove={() => removeDraftSelected(item)} />
                ))}
                {draftLabels.length > 2 && (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">
                    +{draftLabels.length - 2} more
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {filteredTree.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center">
                <div className="text-sm font-semibold text-slate-700">No category matches</div>
                <div className="mt-1 text-xs text-slate-500">Try a broader search term.</div>
              </div>
            ) : filteredTree.map((category) => {
              const categoryId = Number(category.id);
              const subcategories = category.subcategories || [];
              const subcategoryIds = subcategories.map((subcategory) => Number(subcategory.id));
              const selectedSubcategoryCount = subcategoryIds.filter((id) => draftSubcategoryIds.includes(id)).length;
              const categoryChecked = draftCategoryIds.includes(categoryId);
              const categoryPartial = !categoryChecked && selectedSubcategoryCount > 0;
              const expanded = expandedCategoryIds.has(categoryId) || search.trim();
              const showSubcategories = expanded && subcategories.length > 0;

              return (
                <div
                  key={category.id}
                  className={`rounded-xl border transition-colors ${
                    categoryChecked || categoryPartial
                      ? 'border-blue-100 bg-blue-50/70'
                      : 'border-transparent hover:border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="group flex items-center gap-2 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(categoryId)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                      title={expanded ? 'Collapse category' : 'Expand category'}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleCategory(categoryId)}
                      className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white"
                    >
                      <CheckboxMark checked={categoryChecked} partial={categoryPartial} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-slate-900">{category.name}</span>
                        <span className="block truncate text-[11px] font-medium text-slate-500">
                          {categoryChecked ? `${subcategories.length} subcategories included` : selectedSubcategoryCount > 0 ? `${selectedSubcategoryCount} exact subcategory selected` : `${subcategories.length} subcategories`}
                        </span>
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        categoryChecked || selectedSubcategoryCount > 0
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}>
                        {categoryChecked ? 'All' : selectedSubcategoryCount || subcategories.length}
                      </span>
                    </button>
                  </div>

                  {showSubcategories && (
                    <div className="mb-1 ml-11 space-y-0.5 border-l border-slate-200 pl-2 pr-2">
                      {subcategories.map((subcategory) => {
                        const subcategoryId = Number(subcategory.id);
                        const checked = draftSubcategoryIds.includes(subcategoryId);
                        return (
                          <button
                            key={subcategory.id}
                            type="button"
                            onClick={() => chooseSubcategory(subcategoryId, categoryId)}
                            className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                              checked
                                ? 'bg-white text-blue-800 shadow-sm'
                                : categoryChecked
                                  ? 'text-slate-600 hover:bg-white hover:text-slate-900'
                                  : 'text-slate-700 hover:bg-white'
                            }`}
                            title={categoryChecked ? 'Click to narrow this category filter to this exact subcategory' : undefined}
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${checked ? 'bg-blue-600' : categoryChecked ? 'bg-blue-200' : 'bg-slate-300 group-hover:bg-blue-400'}`} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{subcategory.name}</span>
                            {checked && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                </div>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 p-3">
            <span className="text-xs font-medium text-slate-500">
              {draftCount > 0 ? `${draftCount} active filter${draftCount === 1 ? '' : 's'}` : 'No category filters'}
            </span>
            <button
              type="button"
              onClick={clearDraft}
              disabled={draftCount === 0}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
