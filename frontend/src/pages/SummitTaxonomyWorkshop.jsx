import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Icons from 'lucide-react';
import * as XLSX from 'xlsx';
import { QRCodeSVG } from 'qrcode.react';
import AppShell from '../components/AppShell';
import { summitAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';

const ICONS = [
  'KeyRound', 'ShieldAlert', 'MonitorCog', 'AppWindow', 'Share2', 'Network', 'CloudCog',
  'ShoppingCart', 'UsersRound', 'Smartphone', 'ArchiveX', 'Laptop', 'Mail', 'FolderKey',
  'Printer', 'Wifi', 'Server', 'Sparkles', 'Workflow', 'ClipboardList', 'BadgeDollarSign',
  'Rocket', 'DatabaseBackup', 'Lock', 'Projector', 'Map', 'PhoneCall', 'Boxes',
];

const COLORS = ['#0f4c81', '#b42318', '#2563eb', '#7c3aed', '#0891b2', '#0f766e', '#4f46e5', '#c2410c', '#334155', '#16a34a', '#64748b'];

function Icon({ name, className = 'h-4 w-4' }) {
  const LucideIcon = Icons[name] || Icons.Tags;
  return <LucideIcon className={className} />;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function makeId(prefix, label) {
  return `${prefix}_${String(label || 'item').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}_${Date.now().toString(36)}`;
}

function normalizeLabel(label) {
  return String(label || '').trim().toLowerCase();
}

function fuzzyMatchText(value, query) {
  const haystack = normalizeLabel(value);
  const needle = normalizeLabel(query);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;

  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

function categorySearchText(category) {
  return [
    category.name,
    category.description,
    category.evidence,
    ...(category.subcategories || []).filter(subcat => !subcat.deleted).flatMap(subcat => [subcat.name, subcat.evidence, subcat.notes]),
  ].filter(Boolean).join(' ');
}

function subcategorySearchText(subcategory) {
  return [subcategory.name, subcategory.evidence, subcategory.notes].filter(Boolean).join(' ');
}

function HighlightText({ text, query, className = '' }) {
  const value = String(text || '');
  const needle = String(query || '').trim();
  if (!needle) return <span className={className}>{value}</span>;

  const lowerValue = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const index = lowerValue.indexOf(lowerNeedle);
  if (index >= 0) {
    return (
      <span className={className}>
        {value.slice(0, index)}
        <mark className="rounded bg-yellow-200 px-0.5 text-slate-950">{value.slice(index, index + needle.length)}</mark>
        {value.slice(index + needle.length)}
      </span>
    );
  }

  const chars = [];
  let cursor = 0;
  const matched = new Set();
  for (const char of lowerNeedle) {
    cursor = lowerValue.indexOf(char, cursor);
    if (cursor === -1) return <span className={className}>{value}</span>;
    matched.add(cursor);
    cursor += 1;
  }
  for (let i = 0; i < value.length; i += 1) {
    chars.push(matched.has(i)
      ? <mark key={i} className="rounded bg-yellow-100 px-0.5 text-slate-950">{value[i]}</mark>
      : <span key={i}>{value[i]}</span>);
  }
  return <span className={className}>{chars}</span>;
}

function flattenRows(state) {
  const rows = [];
  (state?.categories || []).filter(c => !c.deleted).forEach((cat, index) => {
    rows.push({
      Level: 'Top Category',
      Parent: '',
      Name: cat.name,
      Description: cat.description || '',
      Icon: cat.icon || '',
      Color: cat.color || '',
      Status: cat.status || 'draft',
      Order: index + 1,
      Evidence: cat.evidence || '',
      Notes: cat.notes || '',
    });
    (cat.subcategories || []).filter(s => !s.deleted).forEach((subcat, subIndex) => {
      rows.push({
        Level: 'Subcategory',
        Parent: cat.name,
        Name: subcat.name,
        Description: subcat.description || '',
        Icon: subcat.icon || '',
        Color: cat.color || '',
        Status: subcat.status || 'draft',
        Order: `${index + 1}.${subIndex + 1}`,
        Evidence: subcat.evidence || '',
        Notes: '',
      });
    });
  });
  return rows;
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find(v => v.itemId === itemId && v.voteType === voteType)?.count || 0;
}

function linkedVoteCount(votes, item, voteType = 'support') {
  const ids = new Set([item?.id, item?.sourceSuggestionItemId].filter(Boolean));
  return [...ids].reduce((sum, id) => sum + voteCount(votes, id, voteType), 0);
}

function normalizeVotes(votes) {
  return {
    participantCount: votes?.participantCount || 0,
    totals: Array.isArray(votes?.totals) ? votes.totals : [],
    mergeSuggestions: Array.isArray(votes?.mergeSuggestions) ? votes.mergeSuggestions : [],
    categorySuggestions: Array.isArray(votes?.categorySuggestions) ? votes.categorySuggestions : [],
    participantStats: Array.isArray(votes?.participantStats) ? votes.participantStats : [],
  };
}

function totalVoteCount(votes) {
  return (votes?.totals || []).reduce((sum, vote) => sum + (vote.count || 0), 0);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toastToneClasses(tone) {
  if (tone === 'amber') return {
    border: 'border-amber-200',
    icon: 'bg-amber-100 text-amber-700',
    bar: 'bg-amber-400',
  };
  if (tone === 'emerald') return {
    border: 'border-emerald-200',
    icon: 'bg-emerald-100 text-emerald-700',
    bar: 'bg-emerald-400',
  };
  if (tone === 'red') return {
    border: 'border-red-200',
    icon: 'bg-red-100 text-red-700',
    bar: 'bg-red-400',
  };
  return {
    border: 'border-cyan-200',
    icon: 'bg-cyan-100 text-cyan-700',
    bar: 'bg-cyan-400',
  };
}

function activityToneClasses(tone) {
  if (tone === 'amber') return 'bg-amber-100 text-amber-700';
  if (tone === 'emerald') return 'bg-emerald-100 text-emerald-700';
  if (tone === 'violet') return 'bg-violet-100 text-violet-700';
  return 'bg-cyan-100 text-cyan-700';
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function CardActionsMenu({
  value,
  color = '#0f4c81',
  isOpen,
  onToggle,
  onRename,
  onIconSelect,
  onColorSelect,
  onRemove,
  extraActions = null,
  label = 'Card actions',
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-900 hover:shadow-md"
        title={label}
        aria-label={label}
      >
        <Icons.EllipsisVertical className="h-5 w-5" />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-12 z-[120] w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase text-slate-500">{label}</div>
            <button type="button" onClick={onToggle} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <Icons.X className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-3 grid gap-2">
            <button
              type="button"
              onClick={() => {
                onToggle();
                onRename?.();
              }}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-800 transition hover:bg-white hover:shadow-sm"
            >
              <Icons.Pencil className="h-4 w-4 text-slate-500" />
              Rename
            </button>
            {extraActions}
          </div>
          <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Icon</div>
          <div className="grid max-h-64 grid-cols-7 gap-1 overflow-auto pr-1">
            {ICONS.map((iconName) => (
              <button
                key={iconName}
                type="button"
                onClick={() => onIconSelect(iconName)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border transition hover:-translate-y-0.5 hover:shadow-sm ${
                  iconName === value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white'
                }`}
                title={iconName}
              >
                <Icon name={iconName} className="h-4 w-4" />
              </button>
            ))}
          </div>
          {onColorSelect && (
            <>
              <div className="mb-2 mt-3 text-xs font-semibold uppercase text-slate-500">Color</div>
              <div className="grid grid-cols-8 gap-1">
                {COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => onColorSelect(swatch)}
                    className={`h-8 rounded-lg border transition hover:-translate-y-0.5 hover:shadow-sm ${swatch === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-slate-200'}`}
                    style={{ backgroundColor: swatch }}
                    title={swatch}
                  />
                ))}
                <label className="flex h-8 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 transition hover:bg-white hover:text-slate-900">
                  <Icons.Palette className="h-4 w-4" />
                  <input type="color" value={color} onChange={(event) => onColorSelect(event.target.value)} className="sr-only" />
                </label>
              </div>
            </>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => {
                onToggle();
                onRemove();
              }}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-sm font-semibold text-red-700 transition hover:bg-red-100"
            >
              <Icons.Trash2 className="h-4 w-4" />
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SummitTaxonomyWorkshop() {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();
  const [state, setState] = useState(null);
  const [session, setSession] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [votes, setVotes] = useState(() => normalizeVotes());
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [selectedForMerge, setSelectedForMerge] = useState([]);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const [dragPosition, setDragPosition] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);
  const [saveStatus, setSaveStatus] = useState('Loading...');
  const [error, setError] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [topCategoriesCollapsed, setTopCategoriesCollapsed] = useState(false);
  const [showVotes, setShowVotes] = useState(true);
  const [showRegenerateLinkConfirm, setShowRegenerateLinkConfirm] = useState(false);
  const [showVotingShare, setShowVotingShare] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [activityFeed, setActivityFeed] = useState([]);
  const [highlightIds, setHighlightIds] = useState({});
  const [countdownMs, setCountdownMs] = useState(0);
  const [newSubcategoryName, setNewSubcategoryName] = useState('');
  const [newSubcategoryEvidence, setNewSubcategoryEvidence] = useState('');
  const [iconPickerTarget, setIconPickerTarget] = useState(null);
  const [taxonomySearch, setTaxonomySearch] = useState('');
  const [participantResetTarget, setParticipantResetTarget] = useState(null);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const votesRef = useRef(normalizeVotes());
  const toastIdRef = useRef(0);
  const activityIdRef = useRef(0);
  const subcategoryNameInputRef = useRef(null);
  const categoryNameInputRef = useRef(null);
  const subcategoryNameInputRefs = useRef({});

  const isItWorkspace = Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it';
  const activeCategories = useMemo(() => (state?.categories || []).filter(c => !c.deleted), [state]);
  const searchNeedle = taxonomySearch.trim();
  const visibleCategories = useMemo(() => {
    if (!searchNeedle) return activeCategories;
    return activeCategories.filter(category => fuzzyMatchText(categorySearchText(category), searchNeedle));
  }, [activeCategories, searchNeedle]);
  const deletedItems = useMemo(() => [
    ...(state?.deletedItems || []),
    ...(state?.categories || []).filter(c => c.deleted).map(c => ({ ...c, type: 'category' })),
  ], [state]);
  const selectedCategory = visibleCategories.find(c => c.id === selectedCategoryId) || visibleCategories[0] || activeCategories.find(c => c.id === selectedCategoryId) || activeCategories[0] || null;
  const visibleSubcategories = useMemo(() => {
    const subcategories = (selectedCategory?.subcategories || []).filter(subcat => !subcat.deleted);
    if (!searchNeedle || fuzzyMatchText([selectedCategory?.name, selectedCategory?.description].filter(Boolean).join(' '), searchNeedle)) {
      return subcategories;
    }
    return subcategories.filter(subcategory => fuzzyMatchText(subcategorySearchText(subcategory), searchNeedle));
  }, [searchNeedle, selectedCategory]);
  const acceptedSuggestionItemIds = useMemo(() => {
    const ids = new Set();
    activeCategories.forEach((category) => {
      if (category.sourceSuggestionItemId) ids.add(category.sourceSuggestionItemId);
      if (category.sourceSuggestionId) ids.add(category.id);
      (category.subcategories || []).forEach((subcategory) => {
        if (subcategory.deleted) return;
        if (subcategory.sourceSuggestionItemId) ids.add(subcategory.sourceSuggestionItemId);
        if (subcategory.sourceSuggestionId) ids.add(subcategory.id);
      });
    });
    return ids;
  }, [activeCategories]);
  const topCategorySuggestions = useMemo(
    () => (votes.categorySuggestions || []).filter(suggestion => suggestion.value?.scope !== 'subcategory' && !acceptedSuggestionItemIds.has(suggestion.itemId)),
    [acceptedSuggestionItemIds, votes.categorySuggestions],
  );
  const pendingSubcategorySuggestionCount = useMemo(
    () => (votes.categorySuggestions || []).filter(suggestion => suggestion.value?.scope === 'subcategory' && !acceptedSuggestionItemIds.has(suggestion.itemId)).length,
    [acceptedSuggestionItemIds, votes.categorySuggestions],
  );
  const liveVoteLeaders = useMemo(
    () => (votes.totals || []).filter(vote => vote.voteType === 'support' && vote.count > 0).slice(0, 6),
    [votes.totals],
  );
  const risingIdeas = useMemo(() => {
    const recentWindowMs = 10 * 60 * 1000;
    const recentCutoff = Date.now() - recentWindowMs;
    const recentCounts = activityFeed.reduce((map, activity) => {
      if (!activity.itemId || !activity.timestamp || new Date(activity.timestamp).getTime() < recentCutoff) return map;
      map.set(activity.itemId, (map.get(activity.itemId) || 0) + 1);
      return map;
    }, new Map());

    return (votes.categorySuggestions || [])
      .filter(suggestion => !acceptedSuggestionItemIds.has(suggestion.itemId))
      .map((suggestion) => {
        const support = voteCount(votes, suggestion.itemId);
        const recentActivity = recentCounts.get(suggestion.itemId) || 0;
        return {
          ...suggestion,
          support,
          recentActivity,
          score: support * 2 + recentActivity,
        };
      })
      .filter(suggestion => suggestion.score > 0 || suggestion.recentActivity > 0)
      .sort((a, b) => b.score - a.score || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 5);
  }, [acceptedSuggestionItemIds, activityFeed, votes]);
  const subcategorySuggestionsByParent = useMemo(() => {
    const groups = new Map();
    (votes.categorySuggestions || [])
      .filter(suggestion => suggestion.value?.scope === 'subcategory' && suggestion.value?.parentId && !acceptedSuggestionItemIds.has(suggestion.itemId))
      .forEach((suggestion) => {
        const parentId = suggestion.value.parentId;
        groups.set(parentId, [...(groups.get(parentId) || []), suggestion]);
      });
    return groups;
  }, [acceptedSuggestionItemIds, votes.categorySuggestions]);
  const isSearchMode = Boolean(searchNeedle);
  const categoryOwnMatches = (category) => fuzzyMatchText([category?.name, category?.description, category?.evidence].filter(Boolean).join(' '), searchNeedle);
  const getVisibleSubcategoriesForCategory = (category) => {
    const subcategories = (category?.subcategories || []).filter(subcat => !subcat.deleted);
    if (!searchNeedle || categoryOwnMatches(category)) return subcategories;
    return subcategories.filter(subcategory => fuzzyMatchText(subcategorySearchText(subcategory), searchNeedle));
  };
  const mainCategories = isSearchMode ? visibleCategories : selectedCategory ? [selectedCategory] : [];
  const searchVisibleSubcategoryCount = isSearchMode
    ? visibleCategories.reduce((sum, category) => sum + getVisibleSubcategoriesForCategory(category).length, 0)
    : visibleSubcategories.length;
  const selectedCategorySuggestions = selectedCategory ? subcategorySuggestionsByParent.get(selectedCategory.id) || [] : [];

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const pushToast = useCallback(({ title, message, details = [], icon = 'Bell', tone = 'cyan', duration = 6500 }) => {
    const id = `${Date.now()}_${toastIdRef.current += 1}`;
    setToasts(prev => [{ id, title, message, details, icon, tone, duration }, ...prev].slice(0, 5));
    window.setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id));
    }, duration);
  }, []);

  const addActivity = useCallback(({ type, title, detail, actor, icon = 'Activity', tone = 'cyan', itemId = null }) => {
    const id = `${Date.now()}_${activityIdRef.current += 1}`;
    setActivityFeed(prev => [{
      id,
      type,
      title,
      detail,
      actor,
      icon,
      tone,
      itemId,
      timestamp: new Date().toISOString(),
    }, ...prev].slice(0, 40));
  }, []);

  const markHighlight = useCallback((id) => {
    setHighlightIds(prev => ({ ...prev, [id]: true }));
    window.setTimeout(() => {
      setHighlightIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 8000);
  }, []);

  const applyVotes = useCallback((incomingVotes, { silent = false } = {}) => {
    const next = normalizeVotes(incomingVotes);
    const previous = votesRef.current || normalizeVotes();

    if (!silent) {
      const findRecentActor = (itemId, voteType) => {
        const matches = next.participantStats.flatMap(participant => (participant.recentItems || [])
          .filter(item => item.itemId === itemId && item.voteType === voteType)
          .map(item => ({ participant, item })));
        matches.sort((a, b) => new Date(b.item.createdAt || 0) - new Date(a.item.createdAt || 0));
        return matches[0]?.participant?.displayName || null;
      };
      const previousMergeIds = new Set(previous.mergeSuggestions.map(suggestion => suggestion.id));
      const previousIdeaIds = new Set(previous.categorySuggestions.map(suggestion => suggestion.id));
      const previousParticipantIds = new Set(previous.participantStats.map(participant => participant.id));
      const previousSupportCounts = new Map(previous.totals.filter(vote => vote.voteType === 'support').map(vote => [vote.itemId, vote.count || 0]));
      const newMergeSuggestions = next.mergeSuggestions.filter(suggestion => !previousMergeIds.has(suggestion.id));
      const newCategoryIdeas = next.categorySuggestions.filter(suggestion => !previousIdeaIds.has(suggestion.id));
      const newParticipants = next.participantStats.filter(participant => !previousParticipantIds.has(participant.id));
      const changedSupportVotes = next.totals
        .filter(vote => vote.voteType === 'support' && (vote.count || 0) !== (previousSupportCounts.get(vote.itemId) || 0))
        .map(vote => ({ ...vote, delta: (vote.count || 0) - (previousSupportCounts.get(vote.itemId) || 0) }));

      newCategoryIdeas.slice(0, 3).forEach((suggestion) => {
        markHighlight(`idea-${suggestion.id}`);
        markHighlight('ideas');
        addActivity({
          type: 'idea',
          title: suggestion.value?.scope === 'subcategory' ? 'Subcategory idea' : 'Category idea',
          detail: suggestion.value?.parentName ? `${suggestion.itemLabel} under ${suggestion.value.parentName}` : suggestion.itemLabel,
          actor: suggestion.participantName,
          icon: 'Lightbulb',
          tone: 'amber',
          itemId: suggestion.itemId,
        });
        pushToast({
          title: suggestion.value?.scope === 'subcategory' ? 'New subcategory idea' : 'New category idea',
          message: suggestion.itemLabel,
          details: [
            `From ${suggestion.participantName || 'participant'}`,
            suggestion.value?.parentName ? `Under ${suggestion.value.parentName}` : 'Top-level category',
            suggestion.value?.reason ? `Reason: ${suggestion.value.reason}` : null,
          ],
          icon: 'Lightbulb',
          tone: 'amber',
          duration: 8500,
        });
      });

      newMergeSuggestions.slice(0, 3).forEach((suggestion) => {
        markHighlight(`merge-${suggestion.id}`);
        addActivity({
          type: 'merge',
          title: 'Merge suggestion',
          detail: `${suggestion.value?.from || 'Category'} + ${suggestion.value?.to || 'Category'}`,
          actor: suggestion.participantName,
          icon: 'Merge',
          tone: 'violet',
          itemId: suggestion.itemId,
        });
        pushToast({
          title: 'New merge suggestion',
          message: `${suggestion.value?.from || 'Category'} + ${suggestion.value?.to || 'Category'}`,
          details: [
            `From ${suggestion.participantName || 'participant'}`,
            suggestion.value?.reason ? `Reason: ${suggestion.value.reason}` : null,
          ],
          icon: 'Merge',
          tone: 'cyan',
          duration: 8500,
        });
      });

      changedSupportVotes.slice(0, 6).forEach((vote) => {
        markHighlight(`vote-${vote.itemId}`);
        if (vote.delta > 0) {
          addActivity({
            type: 'vote',
            title: 'Vote added',
            detail: vote.itemLabel || 'Workshop item',
            actor: findRecentActor(vote.itemId, 'support'),
            icon: 'ThumbsUp',
            tone: 'cyan',
            itemId: vote.itemId,
          });
        }
      });

      if (next.participantCount > previous.participantCount) {
        markHighlight('participants');
        const names = newParticipants.map(participant => participant.displayName).filter(Boolean);
        newParticipants.slice(0, 4).forEach((participant) => {
          addActivity({
            type: 'participant',
            title: 'Participant joined',
            detail: `${next.participantCount} total participants`,
            actor: participant.displayName,
            icon: 'UserPlus',
            tone: 'emerald',
          });
        });
        pushToast({
          title: 'Participant joined',
          message: names.length ? names.slice(0, 2).join(', ') : `${next.participantCount} connected`,
          details: [
            `${pluralize(next.participantCount, 'participant')} now connected`,
          ],
          icon: 'UserPlus',
          tone: 'emerald',
        });
      }

      const positiveVoteChanges = changedSupportVotes.filter(vote => vote.delta > 0);
      if (positiveVoteChanges.length) markHighlight('votes');
      if (!newCategoryIdeas.length && !newMergeSuggestions.length && positiveVoteChanges.length) {
        const leader = positiveVoteChanges[0];
        pushToast({
          title: positiveVoteChanges.length === 1 ? 'Vote received' : 'Votes received',
          message: leader.itemLabel || 'Workshop item',
          details: [
            `${leader.count} support vote${leader.count === 1 ? '' : 's'} now`,
            positiveVoteChanges.length > 1 ? `${positiveVoteChanges.length - 1} more item${positiveVoteChanges.length === 2 ? '' : 's'} changed` : null,
            `${pluralize(totalVoteCount(next), 'total vote')}`,
          ],
          icon: 'ThumbsUp',
          tone: 'cyan',
          duration: 4200,
        });
      }
    }

    votesRef.current = next;
    setVotes(next);
  }, [addActivity, markHighlight, pushToast]);

  useEffect(() => {
    let cancelled = false;
    summitAPI.getWorkshop()
      .then((res) => {
        if (cancelled) return;
        setSession(res.session);
        setState(res.session.state);
        setSnapshots(res.snapshots || []);
        applyVotes(res.votes, { silent: true });
        setSelectedCategoryId(res.session.state?.categories?.find(c => !c.deleted)?.id || null);
        setSaveStatus('Saved');
        setLastSavedAt(res.session.updatedAt);
        hydratedRef.current = true;
      })
      .catch((err) => setError(err.message || 'Failed to load workshop'));
    return () => { cancelled = true; };
  }, [applyVotes]);

  useEffect(() => {
    if (!session?.voteToken) return undefined;
    let source;
    try {
      source = summitAPI.getPublicEventSource(session.voteToken);
      source.addEventListener('votes', (event) => applyVotes(JSON.parse(event.data)));
      source.addEventListener('state', (event) => {
        const next = JSON.parse(event.data);
        setSession(prev => prev ? { ...prev, voteEnabled: next.voteEnabled, voteExpiresAt: next.voteExpiresAt } : prev);
      });
    } catch {
      return undefined;
    }
    return () => source?.close();
  }, [applyVotes, session?.voteToken]);

  useEffect(() => {
    if (!session?.voteExpiresAt) {
      setCountdownMs(0);
      return undefined;
    }
    const tick = () => setCountdownMs(new Date(session.voteExpiresAt).getTime() - Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session?.voteExpiresAt]);

  useEffect(() => {
    if (!hydratedRef.current || !state) return undefined;
    setSaveStatus('Autosaving...');
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      summitAPI.saveState(state, { label: 'Autosave', snapshotType: 'autosave' })
        .then((res) => {
          setSession(res.session);
          setSnapshots(res.snapshots || []);
          applyVotes(res.votes, { silent: true });
          setSaveStatus('Saved');
          setLastSavedAt(res.session.updatedAt);
        })
        .catch((err) => setSaveStatus(err.message || 'Autosave failed'));
    }, 1800);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [applyVotes, state]);

  const commit = (updater) => {
    setState((current) => {
      if (!current) return current;
      const before = cloneState(current);
      const next = typeof updater === 'function' ? updater(cloneState(current)) : updater;
      setHistory(prev => [...prev.slice(-29), before]);
      setFuture([]);
      return { ...next, lastEditedAt: new Date().toISOString() };
    });
  };

  const manualSave = async () => {
    if (!state) return;
    setSaveStatus('Saving...');
    const res = await summitAPI.saveState(state, { label: 'Manual summit save', snapshotType: 'manual' });
    setSession(res.session);
    setSnapshots(res.snapshots || []);
    applyVotes(res.votes, { silent: true });
    setSaveStatus('Saved');
    setLastSavedAt(res.session.updatedAt);
  };

  const undo = () => {
    setHistory(prev => {
      if (!prev.length) return prev;
      const previous = prev[prev.length - 1];
      setFuture(f => state ? [cloneState(state), ...f.slice(0, 29)] : f);
      setState(previous);
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture(prev => {
      if (!prev.length) return prev;
      const next = prev[0];
      setHistory(h => state ? [...h.slice(-29), cloneState(state)] : h);
      setState(next);
      return prev.slice(1);
    });
  };

  const updateCategory = (categoryId, patch) => commit((draft) => {
    draft.categories = draft.categories.map(c => c.id === categoryId ? { ...c, ...patch } : c);
    return draft;
  });

  const updateSubcategory = (categoryId, subId, patch) => commit((draft) => {
    draft.categories = draft.categories.map(c => {
      if (c.id !== categoryId) return c;
      return { ...c, subcategories: (c.subcategories || []).map(s => s.id === subId ? { ...s, ...patch } : s) };
    });
    return draft;
  });

  const addCategory = () => {
    const name = 'New Top Category';
    const newCategory = {
      id: makeId('cat', name),
      name,
      icon: 'FolderPlus',
      color: COLORS[(activeCategories.length + 1) % COLORS.length],
      description: '',
      status: 'draft',
      notes: '',
      deleted: false,
      collapsed: false,
      subcategories: [],
    };
    commit((draft) => ({ ...draft, categories: [...draft.categories, newCategory] }));
    setSelectedCategoryId(newCategory.id);
  };

  const createSubcategory = (categoryId, { id, name, evidence = '', icon = 'Tag', status = 'draft', showToast = true, sourceSuggestionItemId = null, sourceSuggestionId = null }) => {
    const trimmedName = String(name || '').trim() || 'New Subcategory';
    const newId = id || makeId('sub', trimmedName);
    commit((draft) => {
      draft.categories = draft.categories.map(c => c.id === categoryId
        ? {
          ...c,
          subcategories: [
            ...(c.subcategories || []),
            {
              id: newId,
              name: trimmedName,
              icon,
              status,
              evidence,
              sourceSuggestionItemId,
              sourceSuggestionId,
              deleted: false,
            },
          ],
        }
        : c);
      return draft;
    });
    markHighlight(`sub-${newId}`);
    if (showToast) {
      pushToast({
        title: 'Subcategory added',
        message: trimmedName,
        icon: 'Tag',
        tone: 'emerald',
      });
    }
    return newId;
  };

  const addSubcategory = (categoryId) => {
    const selectedName = activeCategories.find(category => category.id === categoryId)?.name || 'this category';
    subcategoryNameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => subcategoryNameInputRef.current?.focus(), 150);
    pushToast({
      title: 'Add subcategory',
      message: `Use the bottom row to add it under ${selectedName}.`,
      icon: 'CornerRightDown',
      tone: 'cyan',
    });
  };

  const submitSubcategory = (event) => {
    event.preventDefault();
    if (!selectedCategory || !newSubcategoryName.trim()) return;
    createSubcategory(selectedCategory.id, {
      name: newSubcategoryName,
      evidence: newSubcategoryEvidence.trim(),
    });
    setNewSubcategoryName('');
    setNewSubcategoryEvidence('');
  };

  const isSuggestionAlreadyInCategory = (category, suggestion) => {
    const suggestionName = normalizeLabel(suggestion.itemLabel || suggestion.value?.name);
    return Boolean(suggestionName && (category?.subcategories || []).some(subcat => !subcat.deleted && normalizeLabel(subcat.name) === suggestionName));
  };

  const focusCategoryName = () => {
    window.setTimeout(() => {
      categoryNameInputRef.current?.focus();
      categoryNameInputRef.current?.select();
    }, 50);
  };

  const focusSubcategoryName = (subId) => {
    window.setTimeout(() => {
      subcategoryNameInputRefs.current[subId]?.focus();
      subcategoryNameInputRefs.current[subId]?.select();
    }, 50);
  };

  const openCategoryForEdit = (categoryId, focus = 'category', subId = null) => {
    setSelectedCategoryId(categoryId);
    setTaxonomySearch('');
    window.setTimeout(() => {
      if (focus === 'subcategory' && subId) {
        focusSubcategoryName(subId);
      } else {
        focusCategoryName();
      }
    }, 80);
  };

  const updateDragPosition = (event) => {
    if (event.clientX || event.clientY) {
      setDragPosition({ x: event.clientX, y: event.clientY });
    }
  };

  const setDropTarget = (event, target) => {
    event.preventDefault();
    updateDragPosition(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDragOverTarget(target);
  };

  const startDrag = (event, item) => {
    setDragItem(item);
    setDragPreview(item);
    updateDragPosition(event);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${item.type}:${item.id}`);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    event.dataTransfer.setDragImage(canvas, 0, 0);
  };

  const finishDrag = () => {
    setDragItem(null);
    setDragPreview(null);
    setDragPosition(null);
    setDragOverTarget(null);
  };

  const dropCategory = (event, cat) => {
    event.stopPropagation();
    if (!dragItem) return;
    if (dragItem.type === 'category' && dragItem.id !== cat.id) {
      moveCategory(dragItem.id, cat.id);
      markHighlight(`move-category-${dragItem.id}`);
      markHighlight(`move-category-${cat.id}`);
      pushToast({ title: 'Category moved', message: `${dragItem.name} moved before ${cat.name}`, icon: 'Move', tone: 'cyan' });
    }
    if (dragItem.type === 'sub') {
      moveSubcategory(dragItem.categoryId, dragItem.id, cat.id);
      setSelectedCategoryId(cat.id);
      markHighlight(`move-sub-${dragItem.id}`);
      markHighlight(`move-category-${cat.id}`);
      pushToast({ title: 'Subcategory moved', message: `${dragItem.name} moved into ${cat.name}`, icon: 'Move', tone: 'cyan' });
    }
    finishDrag();
  };

  const dropSubcategory = (event, subcat, targetCategory = selectedCategory) => {
    event.stopPropagation();
    if (dragItem?.type !== 'sub' || dragItem.id === subcat.id || !targetCategory) {
      finishDrag();
      return;
    }
    moveSubcategory(dragItem.categoryId, dragItem.id, targetCategory.id, subcat.id);
    markHighlight(`move-sub-${dragItem.id}`);
    markHighlight(`move-sub-${subcat.id}`);
    pushToast({ title: 'Subcategory moved', message: `${dragItem.name} moved before ${subcat.name}`, icon: 'Move', tone: 'cyan' });
    finishDrag();
  };

  const dropIntoCategory = (event, targetCategory = selectedCategory) => {
    event.stopPropagation();
    if (dragItem?.type === 'sub' && targetCategory) {
      moveSubcategory(dragItem.categoryId, dragItem.id, targetCategory.id);
      markHighlight(`move-sub-${dragItem.id}`);
      markHighlight(`move-category-${targetCategory.id}`);
      pushToast({ title: 'Subcategory moved', message: `${dragItem.name} moved to the end of ${targetCategory.name}`, icon: 'Move', tone: 'cyan' });
    }
    finishDrag();
  };

  const softDeleteCategory = (categoryId) => commit((draft) => {
    draft.categories = draft.categories.map(c => c.id === categoryId ? { ...c, deleted: true, deletedAt: new Date().toISOString() } : c);
    const next = draft.categories.find(c => !c.deleted && c.id !== categoryId);
    setSelectedCategoryId(next?.id || null);
    return draft;
  });

  const softDeleteSubcategory = (categoryId, subId) => commit((draft) => {
    draft.categories = draft.categories.map(c => {
      if (c.id !== categoryId) return c;
      const target = c.subcategories.find(s => s.id === subId);
      draft.deletedItems = [...(draft.deletedItems || []), { ...target, parentId: categoryId, parentName: c.name, type: 'subcategory', deletedAt: new Date().toISOString() }];
      return { ...c, subcategories: c.subcategories.filter(s => s.id !== subId) };
    });
    return draft;
  });

  const restoreDeleted = (item) => commit((draft) => {
    if (item.type === 'category') {
      draft.categories = draft.categories.map(c => c.id === item.id ? { ...c, deleted: false } : c);
      setSelectedCategoryId(item.id);
    } else {
      draft.categories = draft.categories.map(c => c.id === item.parentId
        ? { ...c, subcategories: [...(c.subcategories || []), { ...item, deleted: false }] }
        : c);
      draft.deletedItems = (draft.deletedItems || []).filter(d => d.id !== item.id);
    }
    return draft;
  });

  const moveCategory = (fromId, toId) => commit((draft) => {
    const list = draft.categories;
    const from = list.findIndex(c => c.id === fromId);
    const to = list.findIndex(c => c.id === toId);
    if (from < 0 || to < 0 || from === to) return draft;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    return draft;
  });

  const moveSubcategory = (fromCategoryId, subId, toCategoryId, beforeSubId = null) => commit((draft) => {
    let moving = null;
    draft.categories = draft.categories.map(c => {
      if (c.id !== fromCategoryId) return c;
      moving = (c.subcategories || []).find(s => s.id === subId);
      return { ...c, subcategories: (c.subcategories || []).filter(s => s.id !== subId) };
    });
    if (!moving) return draft;
    draft.categories = draft.categories.map((c) => {
      if (c.id !== toCategoryId) return c;
      const list = [...(c.subcategories || [])];
      const insertAt = beforeSubId ? list.findIndex(s => s.id === beforeSubId) : -1;
      if (insertAt >= 0) list.splice(insertAt, 0, moving);
      else list.push(moving);
      return { ...c, subcategories: list };
    });
    return draft;
  });

  const toggleSelectedForMerge = (categoryId) => {
    setSelectedForMerge(prev => (prev.includes(categoryId) ? prev.filter(id => id !== categoryId) : [...prev, categoryId]));
  };

  const mergeSelectedCategories = () => {
    if (selectedForMerge.length < 2) return;
    const selected = activeCategories.filter(c => selectedForMerge.includes(c.id));
    const keeper = selected[0];
    commit((draft) => {
      const keep = draft.categories.find(c => c.id === keeper.id);
      selected.slice(1).forEach((cat) => {
        keep.subcategories.push({ id: makeId('sub', cat.name), name: cat.name, icon: cat.icon, status: 'merged', evidence: `Merged from top-level category ${cat.name}`, deleted: false });
        keep.subcategories.push(...(cat.subcategories || []).map(s => ({ ...s, id: s.id || makeId('sub', s.name) })));
      });
      draft.categories = draft.categories.map(c => selectedForMerge.includes(c.id) && c.id !== keep.id ? { ...c, deleted: true, deletedAt: new Date().toISOString(), mergedInto: keep.id } : c);
      return draft;
    });
    setSelectedForMerge([]);
    setSelectedCategoryId(keeper.id);
  };

  const addSuggestedCategory = (suggestion) => {
    const name = suggestion.itemLabel || suggestion.value?.name || 'Suggested Category';
    if (suggestion.value?.scope === 'subcategory' && suggestion.value?.parentId && activeCategories.some(category => category.id === suggestion.value.parentId)) {
      createSubcategory(suggestion.value.parentId, {
        id: suggestion.itemId || undefined,
        name,
        icon: 'Lightbulb',
        status: 'suggested',
        evidence: suggestion.value?.reason ? `Suggested by ${suggestion.participantName}: ${suggestion.value.reason}` : `Suggested by ${suggestion.participantName}`,
        sourceSuggestionItemId: suggestion.itemId,
        sourceSuggestionId: suggestion.id,
        showToast: false,
      });
      setSelectedCategoryId(suggestion.value.parentId);
    } else {
      const newCategory = {
        id: suggestion.itemId || makeId('cat', name),
        name,
        icon: 'Lightbulb',
        color: '#f59e0b',
        description: suggestion.value?.reason || '',
        status: 'suggested',
        notes: `Suggested by ${suggestion.participantName}`,
        sourceSuggestionItemId: suggestion.itemId,
        sourceSuggestionId: suggestion.id,
        deleted: false,
        collapsed: false,
        subcategories: [],
      };
      commit((draft) => ({ ...draft, categories: [...draft.categories, newCategory] }));
      setSelectedCategoryId(newCategory.id);
    }
    pushToast({
      title: 'Idea added to categories',
      message: name,
      icon: 'Plus',
      tone: 'emerald',
    });
  };

  const enableVoting = async (regenerate = false) => {
    const res = await summitAPI.enableVoting(120, regenerate);
    setSession(res.session);
    setSnapshots(res.snapshots || []);
    applyVotes(res.votes, { silent: true });
    setShowRegenerateLinkConfirm(false);
    pushToast({
      title: regenerate ? 'Voting link regenerated' : 'Voting link opened',
      message: regenerate ? 'Stats, participants, votes, and suggestions were reset.' : 'The two-hour voting window is live.',
      icon: regenerate ? 'RefreshCcw' : 'Radio',
      tone: regenerate ? 'amber' : 'emerald',
    });
  };

  const resetParticipantVotes = async () => {
    if (!participantResetTarget) return;
    const res = await summitAPI.resetParticipantVotes(participantResetTarget.id);
    applyVotes(res.votes, { silent: true });
    setParticipantResetTarget(null);
    pushToast({
      title: 'Voter reset',
      message: `${participantResetTarget.displayName}'s votes and suggestions were cleared. They can keep voting.`,
      icon: 'UserX',
      tone: 'amber',
    });
  };

  const voteUrl = session?.voteToken ? `${window.location.origin}/summit/vote/${session.voteToken}` : '';
  const effectiveCountdownMs = session?.voteExpiresAt
    ? Math.max(0, countdownMs || new Date(session.voteExpiresAt).getTime() - Date.now())
    : 0;
  const isVotingExpired = Boolean(session?.voteExpiresAt && effectiveCountdownMs <= 0);

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(flattenRows(state)), 'Categories');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.totals || []), 'Votes');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.mergeSuggestions || []), 'Merge Suggestions');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.categorySuggestions || []), 'Category Ideas');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.participantStats || []), 'Voter Stats');
    XLSX.writeFile(workbook, 'BGC-IT-Summit-Categories.xlsx');
  };

  const importJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.categories)) throw new Error('Backup JSON must include categories');
    commit(parsed);
    event.target.value = '';
  };

  const renderMoveSubcategoryAction = (category, subcat) => (
    <div className="rounded-lg border border-cyan-100 bg-cyan-50/70 p-2">
      <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-cyan-900">
        <Icons.MoveRight className="h-3.5 w-3.5" />
        Move to category
      </label>
      <select
        value={category.id}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const nextCategoryId = event.target.value;
          if (!nextCategoryId || nextCategoryId === category.id) return;
          const targetCategory = activeCategories.find(candidate => candidate.id === nextCategoryId);
          moveSubcategory(category.id, subcat.id, nextCategoryId);
          setSelectedCategoryId(nextCategoryId);
          setIconPickerTarget(null);
          pushToast({
            title: 'Subcategory moved',
            message: targetCategory ? `${subcat.name} moved to ${targetCategory.name}` : subcat.name,
            icon: 'MoveRight',
            tone: 'cyan',
          });
        }}
        className="w-full rounded-md border border-cyan-200 bg-white px-2 py-1.5 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100"
      >
        {activeCategories.map(candidate => (
          <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
        ))}
      </select>
    </div>
  );

  const renderCategoryPanel = (category) => {
    const isFocusedEditor = !isSearchMode && selectedCategory?.id === category.id;
    const categorySubcategories = getVisibleSubcategoriesForCategory(category);
    const categorySuggestions = (subcategorySuggestionsByParent.get(category.id) || []).filter((suggestion) => {
      if (!isSearchMode || categoryOwnMatches(category)) return true;
      return fuzzyMatchText([suggestion.itemLabel, suggestion.participantName, suggestion.value?.reason].filter(Boolean).join(' '), searchNeedle);
    });

    return (
      <div
        key={category.id}
        onDragOver={(event) => {
          if (dragItem?.type === 'sub') {
            setDropTarget(event, { type: 'selected-category', id: category.id, label: `move to end of ${category.name}` });
          } else {
            event.preventDefault();
          }
        }}
        onDrop={(event) => dropIntoCategory(event, category)}
        className={`rounded-lg border bg-white p-4 shadow-sm transition-all duration-300 ${
          dragOverTarget?.type === 'selected-category' && category.id === dragOverTarget.id
            ? 'border-cyan-300 ring-2 ring-cyan-100'
            : highlightIds[`move-category-${category.id}`]
              ? 'summit-drop-land border-cyan-300 ring-2 ring-cyan-100'
              : 'border-slate-200'
        }`}
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-1 gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: category.color }}>
              <Icon name={category.icon} className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {isFocusedEditor ? (
                  <input
                    ref={categoryNameInputRef}
                    value={category.name}
                    onChange={(e) => updateCategory(category.id, { name: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-transparent px-1 text-xl font-semibold text-slate-950 outline-none focus:border-slate-300"
                  />
                ) : (
                  <h2 className="min-w-0 flex-1 break-words text-xl font-semibold text-slate-950">
                    <HighlightText text={category.name} query={searchNeedle} />
                  </h2>
                )}
                <span className={`w-fit rounded-lg px-2.5 py-1 text-xs font-bold transition-all duration-300 ${
                  linkedVoteCount(votes, category) > 0 ? 'bg-cyan-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500'
                } ${highlightIds[`vote-${category.id}`] ? 'scale-110 ring-2 ring-cyan-200' : ''}`}>
                  <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                  {linkedVoteCount(votes, category)} votes
                </span>
              </div>
              {isFocusedEditor ? (
                <textarea
                  value={category.description || ''}
                  onChange={(e) => updateCategory(category.id, { description: e.target.value })}
                  rows={2}
                  className="mt-1 w-full resize-none rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 outline-none focus:border-slate-400"
                  placeholder="Describe the category boundary"
                />
              ) : (
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  <HighlightText text={category.description || 'No category description yet.'} query={searchNeedle} />
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {isSearchMode ? (
              <button
                type="button"
                onClick={() => openCategoryForEdit(category.id)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm"
              >
                <Icons.Pencil className="mr-1 inline h-4 w-4" />
                Open/edit
              </button>
            ) : (
              <button onClick={() => addSubcategory(category.id)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md"><Icons.Tag className="mr-1 inline h-4 w-4" />Add sub</button>
            )}
            <CardActionsMenu
              value={category.icon}
              color={category.color}
              isOpen={iconPickerTarget?.type === 'category' && iconPickerTarget.id === category.id}
              onToggle={() => setIconPickerTarget(prev => prev?.type === 'category' && prev.id === category.id ? null : { type: 'category', id: category.id })}
              onRename={() => openCategoryForEdit(category.id)}
              onIconSelect={(iconName) => {
                updateCategory(category.id, { icon: iconName });
                setIconPickerTarget(null);
              }}
              onColorSelect={(color) => updateCategory(category.id, { color })}
              onRemove={() => softDeleteCategory(category.id)}
              label="Category options"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {categorySubcategories.map((subcat) => (
            <div
              key={subcat.id}
              onDragOver={(event) => {
                event.stopPropagation();
                if (dragItem?.type !== 'sub') {
                  event.preventDefault();
                  return;
                }
                setDropTarget(event, { type: 'sub', id: subcat.id, label: `place before ${subcat.name}` });
              }}
              onDragEnter={(event) => {
                event.stopPropagation();
                if (dragItem?.type !== 'sub') {
                  event.preventDefault();
                  return;
                }
                setDropTarget(event, { type: 'sub', id: subcat.id, label: `place before ${subcat.name}` });
              }}
              onDrop={(event) => dropSubcategory(event, subcat, category)}
              className={`group relative rounded-lg border p-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-sm ${
                iconPickerTarget?.type === 'subcategory' && iconPickerTarget.id === subcat.id
                  ? 'z-50 border-slate-300 bg-white shadow-xl'
                  : dragOverTarget?.type === 'sub' && dragOverTarget.id === subcat.id
                    ? 'z-30 scale-[1.015] border-cyan-400 bg-cyan-50 shadow-lg ring-2 ring-cyan-200'
                    : dragItem?.type === 'sub' && dragItem.id === subcat.id
                      ? 'scale-[0.98] border-dashed border-cyan-300 bg-slate-50 opacity-45'
                      : highlightIds[`move-sub-${subcat.id}`]
                        ? 'summit-drop-land border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                        : highlightIds[`sub-${subcat.id}`] || highlightIds[`vote-${subcat.id}`]
                          ? 'border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                          : 'border-slate-200 bg-slate-50'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => startDrag(event, { type: 'sub', categoryId: category.id, id: subcat.id, name: subcat.name, icon: subcat.icon || 'Tag', color: category.color })}
                  onDrag={(event) => updateDragPosition(event)}
                  onDragEnd={finishDrag}
                  className="mt-0.5 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 transition hover:bg-white hover:text-slate-700 active:cursor-grabbing"
                  title="Drag subcategory"
                >
                  <Icons.GripVertical className="h-4 w-4" />
                </button>
                <span className="mt-1 text-slate-500"><Icon name={subcat.icon || 'Tag'} /></span>
                <div className="min-w-0 flex-1">
                  {isFocusedEditor ? (
                    <input
                      ref={(node) => {
                        if (node) subcategoryNameInputRefs.current[subcat.id] = node;
                        else delete subcategoryNameInputRefs.current[subcat.id];
                      }}
                      value={subcat.name}
                      onChange={(e) => updateSubcategory(category.id, subcat.id, { name: e.target.value })}
                      className="w-full rounded border border-transparent bg-transparent text-sm font-semibold text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                    />
                  ) : (
                    <div className="break-words text-sm font-semibold text-slate-900">
                      <HighlightText text={subcat.name} query={searchNeedle} />
                    </div>
                  )}
                  {isFocusedEditor ? (
                    <input value={subcat.evidence || ''} onChange={(e) => updateSubcategory(category.id, subcat.id, { evidence: e.target.value })} className="mt-1 w-full rounded border border-transparent bg-transparent text-xs text-slate-500 outline-none focus:border-slate-300 focus:bg-white" placeholder="Evidence or discussion note" />
                  ) : (
                    <div className="mt-1 break-words text-xs text-slate-500">
                      <HighlightText text={subcat.evidence || 'Evidence or discussion note'} query={searchNeedle} />
                    </div>
                  )}
                </div>
                <span className={`rounded-lg px-2 py-1 text-xs font-bold transition-all duration-300 ${
                  linkedVoteCount(votes, subcat) > 0 ? 'bg-cyan-600 text-white shadow-sm' : 'bg-white text-slate-500'
                }`}>
                  <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                  {linkedVoteCount(votes, subcat)}
                </span>
                <CardActionsMenu
                  value={subcat.icon || 'Tag'}
                  color={category.color}
                  isOpen={iconPickerTarget?.type === 'subcategory' && iconPickerTarget.id === subcat.id}
                  onToggle={() => setIconPickerTarget(prev => prev?.type === 'subcategory' && prev.id === subcat.id ? null : { type: 'subcategory', categoryId: category.id, id: subcat.id })}
                  onRename={() => openCategoryForEdit(category.id, 'subcategory', subcat.id)}
                  onIconSelect={(iconName) => {
                    updateSubcategory(category.id, subcat.id, { icon: iconName });
                    setIconPickerTarget(null);
                  }}
                  onRemove={() => softDeleteSubcategory(category.id, subcat.id)}
                  extraActions={renderMoveSubcategoryAction(category, subcat)}
                  label="Subcategory options"
                />
              </div>
            </div>
          ))}
          {!categorySubcategories.length && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 md:col-span-2">
              No subcategories match this search in {category.name}.
            </div>
          )}
        </div>

        {!!categorySuggestions.length && (
          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50/80 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Icons.Lightbulb className="h-4 w-4 text-amber-700" />
                Suggested subcategories
              </div>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-amber-800">{categorySuggestions.length}</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {categorySuggestions.map((suggestion) => {
                const alreadyAdded = isSuggestionAlreadyInCategory(category, suggestion);
                return (
                  <div
                    key={suggestion.id}
                    className={`rounded-lg border p-3 text-xs transition-all duration-500 ${
                      highlightIds[`idea-${suggestion.id}`]
                        ? 'border-amber-300 bg-white shadow-md ring-2 ring-amber-200'
                        : 'border-amber-100 bg-white/90'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <Icons.Tag className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <div className="min-w-0 flex-1">
                        <div className="break-words text-sm font-semibold text-slate-900">
                          <HighlightText text={suggestion.itemLabel} query={searchNeedle} />
                        </div>
                        <div className="mt-0.5 text-slate-500">Suggested by {suggestion.participantName}</div>
                      </div>
                      <span className={`rounded-lg px-2 py-1 text-xs font-bold ${voteCount(votes, suggestion.itemId) > 0 ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-800'}`}>
                        <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                        {voteCount(votes, suggestion.itemId)}
                      </span>
                    </div>
                    {suggestion.value?.reason && (
                      <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-slate-600">
                        <HighlightText text={suggestion.value.reason} query={searchNeedle} />
                      </div>
                    )}
                    <button
                      onClick={() => addSuggestedCategory(suggestion)}
                      disabled={alreadyAdded}
                      className="mt-3 rounded-md bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                    >
                      <Icons.Plus className="mr-1 inline h-3.5 w-3.5" />
                      {alreadyAdded ? 'Already added' : 'Add subcategory'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isFocusedEditor && (
          <form onSubmit={submitSubcategory} className="mt-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 transition-all duration-300 focus-within:border-cyan-300 focus-within:bg-cyan-50/50 focus-within:ring-2 focus-within:ring-cyan-100">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                <Icons.Tag className="h-4 w-4 shrink-0 text-slate-500" />
                <input
                  ref={subcategoryNameInputRef}
                  value={newSubcategoryName}
                  onChange={(e) => setNewSubcategoryName(e.target.value)}
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm font-semibold text-slate-900 outline-none"
                  placeholder={`Add subcategory under ${category.name}`}
                />
              </div>
              <button
                type="submit"
                disabled={!newSubcategoryName.trim()}
                className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
              >
                <Icons.Plus className="mr-1 inline h-4 w-4" />
                Add sub
              </button>
            </div>
            <input
              value={newSubcategoryEvidence}
              onChange={(e) => setNewSubcategoryEvidence(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 outline-none focus:border-cyan-300"
              placeholder="Evidence or discussion note"
            />
          </form>
        )}
      </div>
    );
  };

  if (!isItWorkspace) {
    return (
      <AppShell activePage="dashboard">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
          This workshop is currently visible only in the IT workspace.
        </div>
      </AppShell>
    );
  }

  if (error) {
    return <AppShell activePage="dashboard"><div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">{error}</div></AppShell>;
  }

  if (!state) {
    return (
      <AppShell activePage="dashboard">
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="rounded-lg border border-slate-200 bg-white px-6 py-5 shadow-sm">
            <Icons.Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-700" />
            <p className="mt-3 text-sm text-slate-600">Loading summit workshop...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell activePage="dashboard" contentClassName="max-w-[1500px] mx-auto w-full px-2 sm:px-4 py-4">
      <style>{`
        @keyframes summitToastIn {
          from { opacity: 0; transform: translate3d(18px, -8px, 0) scale(.98); }
          to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
        }
        @keyframes summitSoftPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(8, 145, 178, 0); }
          50% { box-shadow: 0 0 0 6px rgba(8, 145, 178, .12); }
        }
        @keyframes summitQrPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.015); }
        }
        @keyframes summitDropLand {
          0% { transform: translate3d(0, -7px, 0) scale(.985); box-shadow: 0 0 0 0 rgba(8, 145, 178, .28); }
          45% { transform: translate3d(0, 0, 0) scale(1.018); box-shadow: 0 0 0 7px rgba(8, 145, 178, .16); }
          100% { transform: translate3d(0, 0, 0) scale(1); box-shadow: 0 0 0 0 rgba(8, 145, 178, 0); }
        }
        .summit-toast { animation: summitToastIn 180ms ease-out both; }
        .summit-soft-pulse { animation: summitSoftPulse 1.2s ease-in-out 2; }
        .summit-qr-pulse { animation: summitQrPulse 2.2s ease-in-out infinite; }
        .summit-drop-land { animation: summitDropLand 700ms cubic-bezier(.2,.8,.2,1) both; }
        @media (prefers-reduced-motion: reduce) {
          .summit-toast, .summit-soft-pulse, .summit-qr-pulse, .summit-drop-land { animation: none; }
        }
      `}</style>
      <div className="fixed right-4 top-20 z-[60] w-[min(420px,calc(100vw-2rem))] space-y-2" aria-live="polite">
        {toasts.map((toast) => {
          const tone = toastToneClasses(toast.tone);
          return (
            <div
              key={toast.id}
              className={`summit-toast overflow-hidden rounded-lg border bg-white shadow-xl transition-all duration-300 ${tone.border}`}
            >
              <div className={`h-1 ${tone.bar}`} />
              <div className="p-3">
                <div className="flex gap-3">
                  <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.icon}`}>
                    <Icon name={toast.icon} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-950">{toast.title}</div>
                        <div className="mt-0.5 break-words text-sm text-slate-700">{toast.message}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => dismissToast(toast.id)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95"
                        aria-label={`Dismiss ${toast.title}`}
                        title="Dismiss"
                      >
                        <Icons.X className="h-4 w-4" />
                      </button>
                    </div>
                    {!!toast.details?.filter(Boolean).length && (
                      <div className="mt-2 grid gap-1">
                        {toast.details.filter(Boolean).slice(0, 3).map((detail) => (
                          <div key={detail} className="rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            {detail}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {dragPreview && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[75] flex max-w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-200 bg-white/95 px-4 py-2 text-sm shadow-2xl backdrop-blur transition-all duration-150">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-white">
            <Icons.Move className="h-3.5 w-3.5" />
          </span>
          <span className="max-w-56 truncate font-semibold text-slate-950">Dragging {dragPreview.name}</span>
          <Icons.CornerDownRight className="h-4 w-4 text-slate-400" />
          <span className={`truncate font-medium ${dragOverTarget?.label ? 'text-cyan-800' : 'text-slate-500'}`}>
            {dragOverTarget?.label || 'choose a highlighted target'}
          </span>
        </div>
      )}

      {dragPreview && dragPosition && (
        <div
          className="pointer-events-none fixed z-[80] w-72 -rotate-1 rounded-lg border border-cyan-200 bg-white/80 p-3 text-slate-900 shadow-2xl ring-4 ring-cyan-100/70 backdrop-blur transition-all duration-150 ease-out"
          style={{ left: dragPosition.x + 16, top: dragPosition.y + 16 }}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: dragPreview.color || '#0891b2' }}>
              <Icon name={dragPreview.icon || (dragPreview.type === 'category' ? 'Folder' : 'Tag')} className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{dragPreview.name}</div>
              <div className="text-xs capitalize text-slate-500">{dragPreview.type === 'sub' ? 'Subcategory' : 'Top category'}</div>
            </div>
          </div>
        </div>
      )}

      <div className="mb-3 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-950 px-4 py-3 text-white xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-400 text-slate-950">
                <Icons.Sparkles className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-200">BGC Engineering IT Summit</div>
                <h1 className="truncate text-xl font-semibold">Categories Workshop</h1>
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <span title="Top categories" className="rounded-lg bg-white/10 px-2 py-1 font-semibold"><Icons.Folders className="mr-1 inline h-3.5 w-3.5" />{activeCategories.length}</span>
              <span title="Subcategories" className="rounded-lg bg-white/10 px-2 py-1 font-semibold"><Icons.Tags className="mr-1 inline h-3.5 w-3.5" />{activeCategories.reduce((sum, c) => sum + (c.subcategories || []).filter(s => !s.deleted).length, 0)}</span>
              <span title="Participants" className={`rounded-lg px-2 py-1 font-semibold transition ${highlightIds.participants ? 'bg-cyan-400 text-slate-950' : 'bg-white/10'}`}><Icons.UsersRound className="mr-1 inline h-3.5 w-3.5" />{votes.participantCount || 0}</span>
              <span title="Votes" className={`rounded-lg px-2 py-1 font-semibold transition ${highlightIds.votes ? 'bg-cyan-400 text-slate-950' : 'bg-white/10'}`}><Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />{totalVoteCount(votes)}</span>
              <span title={`${pendingSubcategorySuggestionCount} subcategory ideas`} className={`rounded-lg px-2 py-1 font-semibold transition ${highlightIds.ideas ? 'bg-amber-300 text-slate-950' : 'bg-white/10'}`}><Icons.Lightbulb className="mr-1 inline h-3.5 w-3.5" />{(votes.categorySuggestions || []).length}</span>
              <span title="Save state" className="rounded-lg bg-white/10 px-2 py-1 font-semibold"><Icons.DatabaseZap className="mr-1 inline h-3.5 w-3.5" />{saveStatus}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={() => navigate('/dashboard')} className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 transition hover:bg-white/10" title="Dashboard"><Icons.LayoutDashboard className="h-4 w-4" /></button>
            <button onClick={undo} disabled={!history.length} className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 transition disabled:opacity-40 hover:bg-white/10" title="Undo"><Icons.Undo2 className="h-4 w-4" /></button>
            <button onClick={redo} disabled={!future.length} className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 transition disabled:opacity-40 hover:bg-white/10" title="Redo"><Icons.Redo2 className="h-4 w-4" /></button>
            <button onClick={manualSave} className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400 font-semibold text-slate-950 transition hover:bg-cyan-300" title="Save"><Icons.Save className="h-4 w-4" /></button>
            <button onClick={exportExcel} className="flex h-9 w-9 items-center justify-center rounded-lg bg-white font-semibold text-slate-900 transition hover:bg-slate-100" title="Export Excel"><Icons.FileSpreadsheet className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="grid gap-2 border-b border-slate-200 px-4 py-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-cyan-100 bg-cyan-50/70 px-2 py-2">
            <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-cyan-900">
              <Icons.Activity className="h-4 w-4 text-cyan-700" />
              Live
            </div>
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5">
              {liveVoteLeaders.slice(0, 4).map((vote) => (
                <div
                  key={`${vote.itemId}-${vote.voteType}`}
                  className={`flex min-w-[170px] items-center gap-2 rounded-lg border bg-white px-2 py-1.5 transition-all duration-300 ${
                    highlightIds[`vote-${vote.itemId}`] ? 'summit-soft-pulse border-cyan-300 ring-2 ring-cyan-100' : 'border-cyan-100'
                  }`}
                >
                  <span className="rounded-md bg-cyan-600 px-1.5 py-1 text-xs font-bold text-white">{vote.count}</span>
                  <span className="min-w-0 truncate text-xs font-semibold text-slate-900">{vote.itemLabel}</span>
                </div>
              ))}
              {!liveVoteLeaders.length && <span className="text-xs text-slate-500">Vote leaders appear here as people vote.</span>}
            </div>
          </div>
          <div className={`flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-amber-50/80 px-2 py-2 transition-all duration-300 ${
            highlightIds.ideas ? 'border-amber-300 shadow-md ring-2 ring-amber-100' : 'border-amber-100'
          }`}>
            <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-amber-900">
              <Icons.Flame className="h-4 w-4 text-amber-700" />
              Rising
            </div>
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5">
              {risingIdeas.slice(0, 2).map((idea) => (
                <div
                  key={idea.id}
                  className={`flex min-w-[180px] items-center gap-2 rounded-lg border bg-white px-2 py-1.5 transition-all duration-300 ${
                    highlightIds[`idea-${idea.id}`] || highlightIds[`vote-${idea.itemId}`] ? 'summit-soft-pulse border-amber-300 ring-2 ring-amber-100' : 'border-amber-100'
                  }`}
                >
                  <span className="rounded-md bg-amber-100 px-1.5 py-1 text-xs font-bold text-amber-800">{idea.support}</span>
                  <span className="min-w-0 truncate text-xs font-semibold text-slate-900">{idea.itemLabel}</span>
                </div>
              ))}
              {!risingIdeas.length && <span className="text-xs text-amber-900">Ideas appear here during voting.</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 px-4 py-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center">
            <div className="relative min-w-0 flex-1">
              <Icons.Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={taxonomySearch}
                onChange={(event) => setTaxonomySearch(event.target.value)}
                className="min-h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-9 py-1.5 text-sm text-slate-900 outline-none transition focus:border-cyan-300 focus:bg-white focus:ring-2 focus:ring-cyan-100"
                placeholder="Search categories, subcategories, evidence, notes"
              />
              {taxonomySearch && (
                <button
                  type="button"
                  onClick={() => setTaxonomySearch('')}
                  className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  title="Clear search"
                >
                  <Icons.X className="h-4 w-4" />
                </button>
              )}
            </div>
            <span className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-600">
              {searchNeedle ? `${visibleCategories.length} cat / ${searchVisibleSubcategoryCount} sub` : 'Ready'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <button onClick={addCategory} className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 font-semibold text-slate-700 transition hover:bg-slate-50" title="Add top category"><Icons.FolderPlus className="h-4 w-4" /><span className="hidden sm:inline">Add</span></button>
            <button onClick={() => setShowDeleted(!showDeleted)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50" title="Removed items"><Icons.ArchiveRestore className="h-4 w-4" /></button>
            <button onClick={mergeSelectedCategories} disabled={selectedForMerge.length < 2} className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 font-semibold text-slate-700 transition disabled:opacity-40 hover:bg-slate-50" title="Combine selected categories"><Icons.Merge className="h-4 w-4" /><span>{selectedForMerge.length || ''}</span></button>
            <label className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50" title="Restore JSON">
              <Icons.Upload className="h-4 w-4" />
              <input type="file" accept="application/json" onChange={importJson} className="hidden" />
            </label>
            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(state, null, 2))} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-50" title="Copy JSON"><Icons.Copy className="h-4 w-4" /></button>
            {voteUrl ? (
              <>
                <span className={`flex h-9 items-center rounded-lg px-2.5 text-xs font-semibold ${isVotingExpired ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`} title={`Ends ${new Date(session.voteExpiresAt).toLocaleTimeString()}`}>
                  <Icons.Clock3 className="mr-1 h-4 w-4" />
                  {formatCountdown(effectiveCountdownMs)}
                </span>
                <button onClick={() => navigator.clipboard.writeText(voteUrl)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 font-semibold text-white transition hover:-translate-y-0.5 hover:bg-emerald-500 hover:shadow-md" title="Copy voting link"><Icons.Link className="h-4 w-4" /></button>
                <button onClick={() => setShowVotingShare(true)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-950 font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md" title="Fullscreen QR"><Icons.QrCode className="h-4 w-4" /></button>
                <button onClick={() => setShowRegenerateLinkConfirm(true)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-300 bg-amber-50 font-semibold text-amber-800 transition hover:-translate-y-0.5 hover:bg-amber-100 hover:shadow-md" title="Reset stats and regenerate link"><Icons.RefreshCcw className="h-4 w-4" /></button>
              </>
            ) : (
              <button onClick={() => enableVoting(false)} className="flex h-9 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 font-semibold text-white transition hover:-translate-y-0.5 hover:bg-emerald-500 hover:shadow-md"><Icons.Radio className="h-4 w-4" /><span>Open vote</span></button>
            )}
          </div>
        </div>
      </div>

      <div
        className="grid gap-4 transition-[grid-template-columns] duration-300 ease-out lg:grid-cols-[var(--summit-workshop-grid)]"
        style={{ '--summit-workshop-grid': topCategoriesCollapsed ? '72px minmax(0,1fr) 320px' : '360px minmax(0,1fr) 320px' }}
      >
        <aside className={`relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition-all duration-300 ease-out ${topCategoriesCollapsed ? 'p-2' : 'p-3'}`}>
          <div className={`transition-all duration-300 ease-out ${
            topCategoriesCollapsed ? 'pointer-events-none absolute inset-0 -translate-x-4 opacity-0' : 'relative translate-x-0 opacity-100'
          }`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-900">Top Categories</h2>
              <div className="flex shrink-0 items-center gap-2">
                {selectedForMerge.length > 0 && (
                  <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-semibold text-cyan-800">
                    {selectedForMerge.length} selected
                  </span>
                )}
                <span className="text-xs text-slate-500">Grip to reorder</span>
                <button
                  type="button"
                  onClick={() => setTopCategoriesCollapsed(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-900 hover:shadow-sm"
                  title="Collapse top categories"
                  aria-label="Collapse top categories"
                >
                  <Icons.ChevronsLeft className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {visibleCategories.map((cat) => (
                <div
                  key={cat.id}
                  onDragOver={(event) => setDropTarget(event, {
                    type: 'category',
                    id: cat.id,
                    label: dragItem?.type === 'category' ? `place before ${cat.name}` : `move into ${cat.name}`,
                  })}
                  onDragEnter={(event) => setDropTarget(event, {
                    type: 'category',
                    id: cat.id,
                    label: dragItem?.type === 'category' ? `place before ${cat.name}` : `move into ${cat.name}`,
                  })}
                  onDrop={(event) => {
                    dropCategory(event, cat);
                  }}
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className={`relative w-full rounded-lg border p-3 text-left transition-all duration-300 hover:-translate-y-0.5 hover:shadow-sm ${
                    dragOverTarget?.type === 'category' && dragOverTarget.id === cat.id
                      ? 'scale-[1.015] border-cyan-400 bg-cyan-50 shadow-lg ring-2 ring-cyan-200'
                      : dragItem?.type === 'category' && dragItem.id === cat.id
                        ? 'scale-[0.98] border-dashed border-cyan-300 bg-slate-50 opacity-45'
                        : highlightIds[`move-category-${cat.id}`]
                          ? 'summit-drop-land border-cyan-400 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                          : highlightIds[`vote-${cat.id}`]
                            ? 'border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                            : selectedCategory?.id === cat.id
                              ? 'border-slate-900 bg-slate-50 shadow-sm'
                              : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => startDrag(event, { type: 'category', id: cat.id, name: cat.name, icon: cat.icon, color: cat.color })}
                      onDrag={(event) => updateDragPosition(event)}
                      onDragEnd={finishDrag}
                      onClick={(event) => event.stopPropagation()}
                      className="flex h-9 w-7 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing"
                      title="Drag to reorder"
                    >
                      <Icons.GripVertical className="h-4 w-4" />
                    </button>
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg text-white" style={{ backgroundColor: cat.color }}>
                      <Icon name={cat.icon} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-semibold leading-snug text-slate-900">
                        <HighlightText text={cat.name} query={searchNeedle} />
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">{(cat.subcategories || []).filter(s => !s.deleted).length} subcategories</span>
                      {!!(subcategorySuggestionsByParent.get(cat.id)?.length || 0) && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          {subcategorySuggestionsByParent.get(cat.id).length} ideas
                        </span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSelectedForMerge(cat.id);
                        }}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-all duration-200 ${
                          selectedForMerge.includes(cat.id)
                            ? 'border-cyan-300 bg-cyan-600 text-white shadow-sm ring-2 ring-cyan-100'
                            : 'border-slate-200 bg-white text-slate-400 hover:border-cyan-200 hover:bg-cyan-50 hover:text-cyan-700'
                        }`}
                        title={selectedForMerge.includes(cat.id) ? 'Selected for combine' : 'Select for combine'}
                      >
                        {selectedForMerge.includes(cat.id) ? <Icons.Check className="h-4 w-4" /> : <Icons.Square className="h-4 w-4" />}
                      </button>
                      <span className={`rounded-lg px-2 py-1 text-xs font-bold transition-all duration-300 ${
                        linkedVoteCount(votes, cat) > 0 ? 'bg-cyan-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500'
                      }`}>
                        <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                        {linkedVoteCount(votes, cat)}
                      </span>
                      <div onClick={(event) => event.stopPropagation()}>
                        <CardActionsMenu
                          value={cat.icon}
                          color={cat.color}
                          isOpen={iconPickerTarget?.type === 'category-list' && iconPickerTarget.id === cat.id}
                          onToggle={() => setIconPickerTarget(prev => prev?.type === 'category-list' && prev.id === cat.id ? null : { type: 'category-list', id: cat.id })}
                          onRename={() => openCategoryForEdit(cat.id)}
                          onIconSelect={(iconName) => {
                            updateCategory(cat.id, { icon: iconName });
                            setIconPickerTarget(null);
                          }}
                          onColorSelect={(color) => updateCategory(cat.id, { color })}
                          onRemove={() => softDeleteCategory(cat.id)}
                          label="Category options"
                        />
                      </div>
                    </div>
                  </div>
                  {dragOverTarget?.type === 'category' && dragOverTarget.id === cat.id && (
                    <div className="pointer-events-none absolute inset-x-3 -bottom-2 z-10 flex justify-center">
                      <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-[11px] font-semibold text-white shadow-lg">
                      Drop here: {dragOverTarget.label}
                      </span>
                    </div>
                  )}
                </div>
              ))}
              {!visibleCategories.length && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-500">
                No categories match this search.
                </div>
              )}
            </div>
          </div>

          <div className={`flex flex-col items-center gap-3 p-2 transition-all duration-300 ease-out ${
            topCategoriesCollapsed ? 'relative translate-x-0 opacity-100' : 'pointer-events-none absolute inset-0 translate-x-4 opacity-0'
          }`}>
            <button
              type="button"
              onClick={() => setTopCategoriesCollapsed(false)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-slate-950 text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md"
              title="Expand top categories"
              aria-label="Expand top categories"
            >
              <Icons.ChevronsRight className="h-4 w-4" />
            </button>
            <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-2 text-slate-700">
              <Icons.Folders className="h-4 w-4 text-slate-500" />
              <span className="text-sm font-bold text-slate-950">{activeCategories.length}</span>
            </div>
            <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-cyan-100 bg-cyan-50 px-1.5 py-2 text-cyan-800">
              <Icons.Check className="h-4 w-4" />
              <span className="text-sm font-bold">{selectedForMerge.length}</span>
            </div>
            <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white px-1.5 py-2 text-slate-600">
              <Icons.ThumbsUp className="h-4 w-4 text-slate-500" />
              <span className="text-sm font-bold">{activeCategories.reduce((sum, category) => sum + linkedVoteCount(votes, category), 0)}</span>
            </div>
          </div>
        </aside>

        {isSearchMode ? (
          <section className="space-y-4">
            {mainCategories.map(renderCategoryPanel)}
            {!mainCategories.length && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
                No category or subcategory matches this search.
              </div>
            )}
          </section>
        ) : (
          <section
            onDragOver={(event) => {
              if (selectedCategory && dragItem?.type === 'sub') {
                setDropTarget(event, { type: 'selected-category', id: selectedCategory.id, label: `move to end of ${selectedCategory.name}` });
              } else {
                event.preventDefault();
              }
            }}
            onDrop={(event) => dropIntoCategory(event, selectedCategory)}
            className={`rounded-lg border bg-white p-4 shadow-sm transition-all duration-300 ${
              dragOverTarget?.type === 'selected-category' && selectedCategory?.id === dragOverTarget.id
                ? 'border-cyan-300 ring-2 ring-cyan-100'
                : selectedCategory && highlightIds[`move-category-${selectedCategory.id}`]
                  ? 'summit-drop-land border-cyan-300 ring-2 ring-cyan-100'
                  : 'border-slate-200'
            }`}
          >
            {selectedCategory && (
              <>
                <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: selectedCategory.color }}>
                      <Icon name={selectedCategory.icon} className="h-6 w-6" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          ref={categoryNameInputRef}
                          value={selectedCategory.name}
                          onChange={(e) => updateCategory(selectedCategory.id, { name: e.target.value })}
                          className="min-w-0 flex-1 rounded border border-transparent px-1 text-xl font-semibold text-slate-950 outline-none focus:border-slate-300"
                        />
                        <span className={`w-fit rounded-lg px-2.5 py-1 text-xs font-bold transition-all duration-300 ${
                          linkedVoteCount(votes, selectedCategory) > 0 ? 'bg-cyan-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500'
                        } ${highlightIds[`vote-${selectedCategory.id}`] ? 'scale-110 ring-2 ring-cyan-200' : ''}`}>
                          <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                          {linkedVoteCount(votes, selectedCategory)} votes
                        </span>
                      </div>
                      <textarea
                        value={selectedCategory.description || ''}
                        onChange={(e) => updateCategory(selectedCategory.id, { description: e.target.value })}
                        rows={2}
                        className="mt-1 w-full resize-none rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 outline-none focus:border-slate-400"
                        placeholder="Describe the category boundary"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <button onClick={() => addSubcategory(selectedCategory.id)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md"><Icons.Tag className="mr-1 inline h-4 w-4" />Add sub</button>
                    <CardActionsMenu
                      value={selectedCategory.icon}
                      color={selectedCategory.color}
                      isOpen={iconPickerTarget?.type === 'category' && iconPickerTarget.id === selectedCategory.id}
                      onToggle={() => setIconPickerTarget(prev => prev?.type === 'category' && prev.id === selectedCategory.id ? null : { type: 'category', id: selectedCategory.id })}
                      onRename={focusCategoryName}
                      onIconSelect={(iconName) => {
                        updateCategory(selectedCategory.id, { icon: iconName });
                        setIconPickerTarget(null);
                      }}
                      onColorSelect={(color) => updateCategory(selectedCategory.id, { color })}
                      onRemove={() => softDeleteCategory(selectedCategory.id)}
                      label="Category options"
                    />
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {visibleSubcategories.map((subcat) => (
                    <div
                      key={subcat.id}
                      onDragOver={(event) => {
                        event.stopPropagation();
                        if (dragItem?.type !== 'sub') {
                          event.preventDefault();
                          return;
                        }
                        setDropTarget(event, { type: 'sub', id: subcat.id, label: `place before ${subcat.name}` });
                      }}
                      onDragEnter={(event) => {
                        event.stopPropagation();
                        if (dragItem?.type !== 'sub') {
                          event.preventDefault();
                          return;
                        }
                        setDropTarget(event, { type: 'sub', id: subcat.id, label: `place before ${subcat.name}` });
                      }}
                      onDrop={(event) => dropSubcategory(event, subcat)}
                      className={`group relative rounded-lg border p-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-sm ${
                        iconPickerTarget?.type === 'subcategory' && iconPickerTarget.id === subcat.id
                          ? 'z-50 border-slate-300 bg-white shadow-xl'
                          : dragOverTarget?.type === 'sub' && dragOverTarget.id === subcat.id
                            ? 'z-30 scale-[1.015] border-cyan-400 bg-cyan-50 shadow-lg ring-2 ring-cyan-200'
                            : dragItem?.type === 'sub' && dragItem.id === subcat.id
                              ? 'scale-[0.98] border-dashed border-cyan-300 bg-slate-50 opacity-45'
                              : highlightIds[`move-sub-${subcat.id}`]
                                ? 'summit-drop-land border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                                : highlightIds[`sub-${subcat.id}`] || highlightIds[`vote-${subcat.id}`]
                                  ? 'border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-100'
                                  : 'border-slate-200 bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          draggable
                          onDragStart={(event) => startDrag(event, { type: 'sub', categoryId: selectedCategory.id, id: subcat.id, name: subcat.name, icon: subcat.icon || 'Tag', color: selectedCategory.color })}
                          onDrag={(event) => updateDragPosition(event)}
                          onDragEnd={finishDrag}
                          className="mt-0.5 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 transition hover:bg-white hover:text-slate-700 active:cursor-grabbing"
                          title="Drag subcategory"
                        >
                          <Icons.GripVertical className="h-4 w-4" />
                        </button>
                        <span className="mt-1 text-slate-500"><Icon name={subcat.icon || 'Tag'} /></span>
                        <div className="min-w-0 flex-1">
                          <input
                            ref={(node) => {
                              if (node) subcategoryNameInputRefs.current[subcat.id] = node;
                              else delete subcategoryNameInputRefs.current[subcat.id];
                            }}
                            value={subcat.name}
                            onChange={(e) => updateSubcategory(selectedCategory.id, subcat.id, { name: e.target.value })}
                            className="w-full rounded border border-transparent bg-transparent text-sm font-semibold text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                          />
                          <input value={subcat.evidence || ''} onChange={(e) => updateSubcategory(selectedCategory.id, subcat.id, { evidence: e.target.value })} className="mt-1 w-full rounded border border-transparent bg-transparent text-xs text-slate-500 outline-none focus:border-slate-300 focus:bg-white" placeholder="Evidence or discussion note" />
                        </div>
                        <span className={`rounded-lg px-2 py-1 text-xs font-bold transition-all duration-300 ${
                          linkedVoteCount(votes, subcat) > 0 ? 'bg-cyan-600 text-white shadow-sm' : 'bg-white text-slate-500'
                        }`}>
                          <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                          {linkedVoteCount(votes, subcat)}
                        </span>
                        <CardActionsMenu
                          value={subcat.icon || 'Tag'}
                          color={selectedCategory.color}
                          isOpen={iconPickerTarget?.type === 'subcategory' && iconPickerTarget.id === subcat.id}
                          onToggle={() => setIconPickerTarget(prev => prev?.type === 'subcategory' && prev.id === subcat.id ? null : { type: 'subcategory', categoryId: selectedCategory.id, id: subcat.id })}
                          onRename={() => focusSubcategoryName(subcat.id)}
                          onIconSelect={(iconName) => {
                            updateSubcategory(selectedCategory.id, subcat.id, { icon: iconName });
                            setIconPickerTarget(null);
                          }}
                          onRemove={() => softDeleteSubcategory(selectedCategory.id, subcat.id)}
                          extraActions={renderMoveSubcategoryAction(selectedCategory, subcat)}
                          label="Subcategory options"
                        />
                      </div>
                    </div>
                  ))}
                  {!visibleSubcategories.length && (
                    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 md:col-span-2">
                    No subcategories match this search in {selectedCategory.name}.
                    </div>
                  )}
                </div>

                {!!selectedCategorySuggestions.length && (
                  <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50/80 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <Icons.Lightbulb className="h-4 w-4 text-amber-700" />
                      Suggested subcategories
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-amber-800">{selectedCategorySuggestions.length}</span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {selectedCategorySuggestions.map((suggestion) => {
                        const alreadyAdded = isSuggestionAlreadyInCategory(selectedCategory, suggestion);
                        return (
                          <div
                            key={suggestion.id}
                            className={`rounded-lg border p-3 text-xs transition-all duration-500 ${
                              highlightIds[`idea-${suggestion.id}`]
                                ? 'border-amber-300 bg-white shadow-md ring-2 ring-amber-200'
                                : 'border-amber-100 bg-white/90'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <Icons.Tag className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold text-slate-900">{suggestion.itemLabel}</div>
                                <div className="mt-0.5 text-slate-500">Suggested by {suggestion.participantName}</div>
                              </div>
                              <span className={`rounded-lg px-2 py-1 text-xs font-bold ${voteCount(votes, suggestion.itemId) > 0 ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-800'}`}>
                                <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                                {voteCount(votes, suggestion.itemId)}
                              </span>
                            </div>
                            {suggestion.value?.reason && <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-slate-600">{suggestion.value.reason}</div>}
                            <button
                              onClick={() => addSuggestedCategory(suggestion)}
                              disabled={alreadyAdded}
                              className="mt-3 rounded-md bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                            >
                              <Icons.Plus className="mr-1 inline h-3.5 w-3.5" />
                              {alreadyAdded ? 'Already added' : 'Add subcategory'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <form onSubmit={submitSubcategory} className="mt-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 transition-all duration-300 focus-within:border-cyan-300 focus-within:bg-cyan-50/50 focus-within:ring-2 focus-within:ring-cyan-100">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <Icons.Tag className="h-4 w-4 shrink-0 text-slate-500" />
                      <input
                        ref={subcategoryNameInputRef}
                        value={newSubcategoryName}
                        onChange={(e) => setNewSubcategoryName(e.target.value)}
                        className="min-w-0 flex-1 border-0 bg-transparent text-sm font-semibold text-slate-900 outline-none"
                        placeholder={`Add subcategory under ${selectedCategory.name}`}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!newSubcategoryName.trim()}
                      className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                    >
                      <Icons.Plus className="mr-1 inline h-4 w-4" />
                    Add sub
                    </button>
                  </div>
                  <input
                    value={newSubcategoryEvidence}
                    onChange={(e) => setNewSubcategoryEvidence(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 outline-none focus:border-cyan-300"
                    placeholder="Evidence or discussion note"
                  />
                </form>
              </>
            )}
          </section>
        )}

        <aside className="space-y-4">
          <div className="rounded-lg border border-cyan-100 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icons.Radio className="h-4 w-4 text-cyan-700" />
                <h2 className="text-sm font-semibold text-slate-900">Recent Activity</h2>
              </div>
              <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-semibold text-cyan-800">live</span>
            </div>
            <div className="max-h-80 space-y-2 overflow-auto pr-1">
              {activityFeed.map(activity => (
                <div key={activity.id} className="summit-toast flex gap-3 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${activityToneClasses(activity.tone)}`}>
                    <Icon name={activity.icon} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate font-semibold text-slate-900">{activity.title}</div>
                      <div className="shrink-0 text-[10px] text-slate-400">{new Date(activity.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>
                    </div>
                    <div className="mt-0.5 break-words text-slate-600">{activity.detail}</div>
                    {activity.actor && <div className="mt-1 text-[11px] font-medium text-slate-500">by {activity.actor}</div>}
                  </div>
                </div>
              ))}
              {!activityFeed.length && (
                <p className="text-sm text-slate-500">Live participant joins, votes, category ideas, and merge suggestions will appear here.</p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Live Feedback</h2>
              <button onClick={() => setShowVotes(!showVotes)} className="text-xs text-slate-500 hover:text-slate-900">{showVotes ? 'Hide' : 'Show'}</button>
            </div>
            {showVotes && (
              <div className="space-y-3">
                {(votes.totals || []).slice(0, 8).map(v => (
                  <div key={`${v.itemId}-${v.voteType}`}>
                    <div className="flex justify-between text-xs">
                      <span className="truncate font-medium text-slate-700">{v.itemLabel}</span>
                      <span className="text-slate-500">{v.count}</span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-slate-100">
                      <div className="h-2 rounded bg-cyan-500 transition-all" style={{ width: `${Math.min(100, v.count * 12)}%` }} />
                    </div>
                  </div>
                ))}
                {!(votes.totals || []).length && <p className="text-sm text-slate-500">Votes will appear here once participants join.</p>}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Voter Stats</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{(votes.participantStats || []).length}</span>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto">
              {(votes.participantStats || []).map(participant => (
                <div key={participant.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{participant.displayName}</div>
                      <div className="mt-0.5 text-slate-500">
                        Last activity {participant.lastActivityAt ? new Date(participant.lastActivityAt).toLocaleTimeString() : 'none yet'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-lg bg-white px-2 py-1 font-semibold text-slate-800">{participant.totalCount || 0} total</span>
                      <button
                        type="button"
                        onClick={() => setParticipantResetTarget(participant)}
                        className="rounded-lg border border-red-100 bg-white px-2 py-1 font-semibold text-red-600 transition hover:bg-red-50"
                        title="Reset this voter"
                      >
                        <Icons.UserX className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1 text-center">
                    <div className="rounded-md bg-white px-2 py-1">
                      <div className="font-semibold text-cyan-700">{participant.supportCount || 0}</div>
                      <div className="text-[10px] uppercase text-slate-400">Votes</div>
                    </div>
                    <div className="rounded-md bg-white px-2 py-1">
                      <div className="font-semibold text-amber-700">{participant.categorySuggestionCount || 0}</div>
                      <div className="text-[10px] uppercase text-slate-400">Ideas</div>
                    </div>
                    <div className="rounded-md bg-white px-2 py-1">
                      <div className="font-semibold text-violet-700">{participant.mergeSuggestionCount || 0}</div>
                      <div className="text-[10px] uppercase text-slate-400">Merges</div>
                    </div>
                  </div>
                  {!!participant.recentItems?.length && (
                    <div className="mt-2 space-y-1">
                      {participant.recentItems.slice(0, 2).map(item => (
                        <div key={`${participant.id}-${item.itemId}-${item.voteType}-${item.createdAt}`} className="truncate text-[11px] text-slate-500">
                          {item.voteType === 'support' ? 'Voted for' : item.voteType === 'merge_suggestion' ? 'Merge idea' : 'New idea'}: {item.itemLabel}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!(votes.participantStats || []).length && <p className="text-sm text-slate-500">Per-voter stats will appear after people join.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Top-Level Ideas</h2>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{topCategorySuggestions.length}</span>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto">
              {topCategorySuggestions.map(suggestion => (
                <div
                  key={suggestion.id}
                  className={`rounded-lg border p-3 text-xs transition-all duration-500 ${
                    highlightIds[`idea-${suggestion.id}`]
                      ? 'border-amber-300 bg-amber-50 shadow-md ring-2 ring-amber-200'
                      : 'border-amber-100 bg-amber-50/60'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <Icons.Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900">{suggestion.itemLabel}</div>
                      <div className="mt-0.5 text-slate-500">Suggested by {suggestion.participantName}</div>
                    </div>
                    <span className="rounded-full bg-white px-2 py-0.5 font-semibold text-slate-700">
                      {voteCount(votes, suggestion.itemId)}
                    </span>
                  </div>
                  {suggestion.value?.reason && <div className="mt-2 text-slate-600">{suggestion.value.reason}</div>}
                  <button
                    onClick={() => addSuggestedCategory(suggestion)}
                    className="mt-3 rounded-md bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800"
                  >
                    <Icons.Plus className="mr-1 inline h-3.5 w-3.5" />Add to categories
                  </button>
                </div>
              ))}
              {!topCategorySuggestions.length && <p className="text-sm text-slate-500">Top-level suggestions will appear here. Subcategory suggestions show inside their parent category.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Merge Suggestions</h2>
            <div className="max-h-64 space-y-2 overflow-auto">
              {(votes.mergeSuggestions || []).map(s => (
                <div
                  key={s.id}
                  className={`rounded-lg border p-2 text-xs transition-all duration-500 ${
                    highlightIds[`merge-${s.id}`]
                      ? 'border-cyan-300 bg-cyan-50 shadow-md ring-2 ring-cyan-200'
                      : 'border-slate-100 bg-slate-50'
                  }`}
                >
                  <div className="font-semibold text-slate-800">{s.participantName}</div>
                  <div className="mt-1 text-slate-600">{s.value?.from} + {s.value?.to}</div>
                  {s.value?.reason && <div className="mt-1 text-slate-500">{s.value.reason}</div>}
                </div>
              ))}
              {!(votes.mergeSuggestions || []).length && <p className="text-sm text-slate-500">No merge suggestions yet.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Backups</h2>
            <div className="max-h-64 space-y-2 overflow-auto">
              {snapshots.map(snapshot => (
                <div key={snapshot.id} className="rounded-lg border border-slate-200 p-2">
                  <div className="text-xs font-semibold text-slate-800">v{snapshot.version} / {snapshot.label}</div>
                  <div className="text-[11px] text-slate-500">{new Date(snapshot.createdAt).toLocaleString()}</div>
                  <button onClick={() => summitAPI.restoreSnapshot(snapshot.id).then(res => { setSession(res.session); setState(res.session.state); setSnapshots(res.snapshots || []); })} className="mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900">Restore</button>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {showDeleted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Removed Items</h2>
              <button onClick={() => setShowDeleted(false)}><Icons.X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-2">
              {deletedItems.map(item => (
                <div key={`${item.type}-${item.id}`} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                  <div>
                    <div className="font-medium text-slate-900">{item.name}</div>
                    <div className="text-xs text-slate-500">{item.type}{item.parentName ? ` from ${item.parentName}` : ''}</div>
                  </div>
                  <button onClick={() => restoreDeleted(item)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Restore</button>
                </div>
              ))}
              {!deletedItems.length && <p className="text-sm text-slate-500">Nothing removed yet.</p>}
            </div>
          </div>
        </div>
      )}

      {showVotingShare && voteUrl && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950 p-4 text-white">
          <div className="absolute right-4 top-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(voteUrl)}
              className="rounded-lg border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
            >
              <Icons.Copy className="mr-1 inline h-4 w-4" />
              Copy link
            </button>
            <button
              type="button"
              onClick={() => setShowVotingShare(false)}
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white transition hover:bg-white/15"
              aria-label="Close fullscreen QR"
            >
              <Icons.X className="h-5 w-5" />
            </button>
          </div>
          <div className="grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.22em] text-cyan-200">
                <Icons.Sparkles className="h-5 w-5" />
                BGC Engineering IT Summit
              </div>
              <h2 className="mt-5 text-5xl font-semibold leading-tight lg:text-7xl">Join the category vote</h2>
              <p className="mt-5 max-w-3xl text-xl leading-relaxed text-slate-300">
                Scan the QR code, enter your name, then vote for categories and suggest anything missing.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3 text-base">
                <span className={`rounded-lg px-4 py-3 font-semibold ${isVotingExpired ? 'bg-red-500/15 text-red-100' : 'bg-emerald-400 text-slate-950'}`}>
                  <Icons.Clock3 className="mr-2 inline h-5 w-5" />
                  {formatCountdown(effectiveCountdownMs)} {isVotingExpired ? '' : 'left'}
                </span>
                <span className="rounded-lg border border-white/10 bg-white/10 px-4 py-3 text-slate-100">
                  {pluralize(votes.participantCount || 0, 'participant')}
                </span>
                <span className="rounded-lg border border-white/10 bg-white/10 px-4 py-3 text-slate-100">
                  {pluralize(totalVoteCount(votes), 'vote')}
                </span>
              </div>
              <div className="mt-8 max-w-4xl rounded-xl border border-white/10 bg-white/10 p-4 text-lg font-medium text-cyan-100">
                {voteUrl}
              </div>
            </div>
            <div className="summit-qr-pulse rounded-3xl border border-white/10 bg-white p-5 shadow-2xl">
              <QRCodeSVG value={voteUrl} size={420} marginSize={3} className="aspect-square h-auto w-full rounded-2xl" title="Category workshop voting link" />
              <div className="mt-4 rounded-2xl bg-slate-950 px-4 py-3 text-center text-lg font-semibold text-white">
                Scan to vote
              </div>
            </div>
          </div>
        </div>
      )}

      {showRegenerateLinkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500 text-white">
                  <Icons.RefreshCcw className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Regenerate voting link?</h2>
                  <p className="text-sm text-amber-800">The current public voting URL will stop working.</p>
                </div>
              </div>
            </div>
            <div className="px-5 py-4 text-sm text-slate-600">
              Participants already on the old link will see that the link expired and will need the new link. Participant count, votes, merge suggestions, and category ideas will reset. Category edits and backups stay.
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button onClick={() => setShowRegenerateLinkConfirm(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => enableVoting(true)} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">
                Reset stats and regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {participantResetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="border-b border-red-200 bg-red-50 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-white">
                  <Icons.UserX className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Reset voter?</h2>
                  <p className="text-sm text-red-800">{participantResetTarget.displayName}</p>
                </div>
              </div>
            </div>
            <div className="px-5 py-4 text-sm text-slate-600">
              This clears their votes, category ideas, merge suggestions, and priority selections. They stay connected and can keep voting.
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button onClick={() => setParticipantResetTarget(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={resetParticipantVotes} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">
                Reset voter
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 text-xs text-slate-500">Last saved: {lastSavedAt ? new Date(lastSavedAt).toLocaleString() : 'not yet saved'}</div>
    </AppShell>
  );
}
