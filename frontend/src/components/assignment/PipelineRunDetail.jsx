import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import {
  ChevronDown, ChevronRight, CheckCircle, XCircle, AlertTriangle,
  Loader2, Brain, MapPin, Calendar, BarChart3, Award, MessageSquare,
  ExternalLink, AlertCircle, User, FileText, Mail, Building2, Tag, Sparkles,
  RotateCcw, OctagonAlert, ShieldCheck, UserCog, Search, X, PhoneCall,
  Webhook, RefreshCw, Play,
} from 'lucide-react';
import { CopyBadge, prepareRunTranscriptMarkdown, transcriptMdComponents } from './StreamingComponents';
import { RecommendationCards } from './LivePipelineView';
import HandoffHistoryStrip from './HandoffHistoryStrip';
import { getRecommendationList, withNormalizedRecommendations } from '../../utils/assignmentRecommendations';

const ticketDescriptionMdComponents = {
  ...transcriptMdComponents,
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 underline decoration-blue-200 underline-offset-2 break-words"
      {...props}
    >
      {children}
    </a>
  ),
};

function looksLikeTicketHtml(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 3 || t.charAt(0) !== '<') return false;
  return /<\/?[a-z][a-z0-9-]*\b/i.test(t);
}

/** Strip obvious script/event-handler vectors before rendering FreshService HTML. Not a full sanitizer. */
function sanitizeTicketHtml(html) {
  if (!html) return '';
  return html
    .replace(/<\/(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:\s*/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
}

/** Normalize plain-text / email bodies so Markdown + GFM render cleanly (bold, rules, links). */
function prepareTicketDescriptionMarkdown(text) {
  if (!text) return '';
  let t = text.replace(/\r\n/g, '\n');
  t = t.replace(/^[=*_~]{4,}\s*$/gm, '\n\n---\n\n');
  t = t.replace(/^-{4,}\s*$/gm, '\n\n---\n\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function normalizeTaxonomyLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function taxonomyFitLabel(value) {
  if (value === 'none') return 'missing';
  if (value === 'weak') return 'weak fit';
  return value || null;
}

function ticketPulseCategoryLabel(ticket) {
  if (!ticket) return null;
  if (ticket.internalCategory?.name) {
    return `${ticket.internalCategory.name}${ticket.internalSubcategory?.name ? ` / ${ticket.internalSubcategory.name}` : ''}`;
  }
  if (ticket.tpSkill || ticket.tpSubskill) {
    return [ticket.tpSkill, ticket.tpSubskill].filter(Boolean).join(' / ');
  }
  return null;
}

function isVerifiedReboundContext(ctx) {
  return Boolean(
    ctx
      && (
        ctx.verifiedByFreshserviceActivity === true
        || (ctx.unassignedAt && ctx.previousTechName && ctx.previousTechName !== 'Unknown')
      ),
  );
}

function formatReturnedContext(ctx, workspaceTimezone) {
  if (!ctx) return '';
  return `Returned from ${ctx.previousTechName || 'previous assignee'}${ctx.unassignedAt ? ` at ${formatDateTimeInTimezone(ctx.unassignedAt, workspaceTimezone)}` : ''}${ctx.unassignedByName ? ` by ${ctx.unassignedByName}` : ''}${ctx.reboundCount > 1 ? ` (return #${ctx.reboundCount})` : ''}`;
}

function ticketCategoryReviewNeeded(ticket) {
  if (!ticket) return false;
  return Boolean(ticket.taxonomyReviewNeeded)
    || ['weak', 'none'].includes(ticket.internalCategoryFit)
    || ['weak', 'none'].includes(ticket.internalSubcategoryFit)
    || Boolean(ticket.suggestedInternalCategoryName)
    || Boolean(ticket.suggestedInternalSubcategoryName);
}

const STEP_ICONS = {
  classification: Brain,
  categorization: Award,
  location: MapPin,
  availability: Calendar,
  competency: Award,
  workload: BarChart3,
  recommendation: MessageSquare,
  noise_veto: ShieldCheck,
};

// Per-step icon tint. Unknown step types fall back to the neutral default,
// so new pipeline steps render gracefully without a code change.
const STEP_ICON_CLASSES = {
  noise_veto: 'text-emerald-600 dark:text-emerald-300',
};

const STATUS_STYLES = {
  completed: { icon: CheckCircle, color: 'text-green-600 dark:text-green-300', bg: 'bg-green-50 dark:bg-green-500/15' },
  failed: { icon: XCircle, color: 'text-red-600 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-500/15' },
  running: { icon: Loader2, color: 'text-blue-600 dark:text-blue-300', bg: 'bg-blue-50 dark:bg-blue-500/15' },
  skipped: { icon: AlertTriangle, color: 'text-muted-foreground/75', bg: 'bg-muted/50' },
};

function StepCard({ step }) {
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const statusStyle = STATUS_STYLES[step.status] || STATUS_STYLES.running;
  const StatusIcon = statusStyle.icon;
  const StepIcon = STEP_ICONS[step.stepName] || Brain;
  const stepIconClass = STEP_ICON_CLASSES[step.stepName] || 'text-muted-foreground';

  return (
    <div className={`border rounded-lg ${statusStyle.bg} mb-2`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-card/40 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted-foreground/75 w-5">{step.stepNumber}</span>
          <StepIcon className={`w-4 h-4 ${stepIconClass}`} />
          <span className="font-medium text-sm capitalize">{String(step.stepName || 'step').replace(/_/g, ' ')}</span>
          <StatusIcon className={`w-4 h-4 ${statusStyle.color} ${step.status === 'running' ? 'animate-spin' : ''}`} />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {step.durationMs && <span>{step.durationMs}ms</span>}
          {step.tokensUsed && <span>{step.tokensUsed} tokens</span>}
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {step.output && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Output</h4>
              <pre className="bg-card rounded p-2 text-xs overflow-x-auto max-h-60 border">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}

          {step.input && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Input</h4>
              <pre className="bg-card rounded p-2 text-xs overflow-x-auto max-h-40 border">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}

          {(step.llmPrompt || step.llmResponse) && (
            <div>
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="text-xs text-blue-600 dark:text-blue-300 hover:underline"
              >
                {showPrompt ? 'Hide' : 'Show'} LLM prompt/response
              </button>
              {showPrompt && (
                <div className="mt-2 space-y-2">
                  {step.llmPrompt && (
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground/75">Prompt</h5>
                      <pre className="bg-gray-900 dark:ring-1 dark:ring-white/10 text-green-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmPrompt}
                      </pre>
                    </div>
                  )}
                  {step.llmResponse && (
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground/75">Response</h5>
                      <pre className="bg-gray-900 dark:ring-1 dark:ring-white/10 text-blue-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmResponse}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step.errorMessage && (
            <div className="bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200 rounded p-2 text-xs">
              {step.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function ReasoningCard({ reasoning, recommendations: _recommendations }) {
  if (!reasoning) return null;
  return (
    <div className="bg-gradient-to-br from-indigo-50 dark:from-indigo-500/15 via-blue-50 dark:via-blue-500/15 to-muted/50 border border-indigo-100 dark:border-indigo-500/20 rounded-xl p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <h4 className="text-xs font-semibold text-indigo-700 dark:text-indigo-200 uppercase tracking-wide">Overall Reasoning</h4>
        <span className="ml-auto text-[10px] font-medium text-indigo-500/80 uppercase tracking-wider">Internal</span>
      </div>
      <div className="text-sm text-foreground/85 leading-relaxed prose prose-sm max-w-none prose-p:my-2 prose-headings:text-foreground prose-strong:text-foreground prose-ul:my-2 prose-li:my-0.5">
        <Markdown remarkPlugins={[remarkGfm]} components={ticketDescriptionMdComponents}>{reasoning}</Markdown>
      </div>
    </div>
  );
}

function AgentBriefingCard({ recommendation, decision }) {
  if (!recommendation) return null;

  const recommendations = getRecommendationList(recommendation);
  const isNoise = decision === 'noise_dismissed' || recommendations.length === 0;
  const briefing = isNoise ? recommendation.closureNoticeHtml : recommendation.agentBriefingHtml;
  const fieldName = isNoise ? 'closureNoticeHtml' : 'agentBriefingHtml';

  if (!briefing) {
    return (
      <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <MessageSquare className="w-3.5 h-3.5 text-amber-700 dark:text-amber-200" />
          </div>
          <h4 className="text-xs font-semibold text-amber-800 dark:text-amber-200 uppercase tracking-wide">What the agent will see</h4>
          <span className="ml-auto text-[10px] font-medium text-amber-700/80 uppercase tracking-wider">Public note</span>
        </div>
        <p className="text-xs text-amber-800/90">
          The LLM did not produce a <code className="font-mono bg-amber-100 dark:bg-amber-500/20 px-1 rounded">{fieldName}</code> for this run.
          On sync, the FreshService note will fall back to {isNoise ? 'a generic closure message' : 'the internal reasoning above'} — which may leak routing logic.
          Consider re-running the pipeline to get a clean public briefing.
        </p>
      </div>
    );
  }

  const safeHtml = sanitizeTicketHtml(briefing);

  return (
    <div className="bg-gradient-to-br from-emerald-50 dark:from-emerald-500/15 via-teal-50 dark:via-teal-500/15 to-muted/50 border border-emerald-100 dark:border-emerald-500/20 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-200" />
        </div>
        <h4 className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 uppercase tracking-wide">
          {isNoise ? 'Closure notice (what the agent will see)' : 'What the agent will see'}
        </h4>
        <span className="ml-auto text-[10px] font-medium text-emerald-700/80 uppercase tracking-wider">Public note</span>
      </div>
      <div
        className="text-sm text-foreground/85 leading-relaxed prose prose-sm max-w-none prose-p:my-2 prose-a:text-emerald-700 dark:prose-a:text-emerald-200"
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
    </div>
  );
}

function TicketDetailsCard({ ticket, recommendation }) {
  const [expanded, setExpanded] = useState(false);
  const htmlHostRef = useRef(null);

  const useHtml = Boolean(ticket?.description && looksLikeTicketHtml(ticket.description));
  const rawPlain = !ticket || useHtml
    ? ''
    : (ticket.descriptionText || ticket.description || '').trim();
  const markdownSource = prepareTicketDescriptionMarkdown(
    looksLikeTicketHtml(rawPlain) ? stripHtml(rawPlain) : rawPlain,
  );
  const safeHtml = useHtml && ticket?.description ? sanitizeTicketHtml(ticket.description) : '';

  const plainForMeasure = !ticket ? '' : (useHtml ? stripHtml(ticket.description || '') : rawPlain);

  const needsClamp = plainForMeasure.length > 550 || plainForMeasure.split('\n').length > 12;
  const showToggle = needsClamp;

  useEffect(() => {
    if (!useHtml || !htmlHostRef.current) return;
    htmlHostRef.current.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      // classList.add takes ONE class per argument — a space-separated string throws
      // InvalidCharacterError and crashes the whole route (QA 08-31, run 22206).
      a.classList.add('text-blue-600', 'dark:text-blue-300', 'underline', 'underline-offset-2', 'break-words', 'hover:text-blue-800', 'dark:hover:text-blue-200');
    });
  }, [useHtml, safeHtml]);

  if (!ticket) return null;
  const taxonomyNeedsReview = ticketCategoryReviewNeeded(ticket);
  const taxonomyFitText = [
    ticket.internalCategoryFit ? `Category ${taxonomyFitLabel(ticket.internalCategoryFit)}` : null,
    ticket.internalSubcategoryFit ? `Subcategory ${taxonomyFitLabel(ticket.internalSubcategoryFit)}` : null,
  ].filter(Boolean).join(' · ');
  const assignedTaxonomyLabel = ticket.internalCategory
    ? `${ticket.internalCategory.name}${ticket.internalSubcategory ? ` > ${ticket.internalSubcategory.name}` : ''}`
    : null;
  const sourceCategoryLabels = [
    ticket.category,
    ticket.ticketCategory,
  ].filter((value, index, arr) => (
    value
    && arr.findIndex((candidate) => normalizeTaxonomyLabel(candidate) === normalizeTaxonomyLabel(value)) === index
    && !assignedTaxonomyLabel
    && normalizeTaxonomyLabel(value) !== normalizeTaxonomyLabel(assignedTaxonomyLabel)
    && normalizeTaxonomyLabel(value) !== normalizeTaxonomyLabel(ticket.internalCategory?.name)
  ));
  const hasSuggestedCategory = Boolean(ticket.suggestedInternalCategoryName);
  const hasSuggestedSubcategory = Boolean(ticket.suggestedInternalSubcategoryName);
  const assessedTicketType = ticket.assessedTicketType || recommendation?.ticketType || null;
  const freshserviceTicketType = ticket.ticketType || null;
  const ticketTypeRationale = ticket.ticketTypeRationale || recommendation?.ticketTypeRationale || null;
  const ticketTypeConfidence = ticket.ticketTypeConfidence || recommendation?.ticketTypeConfidence || null;

  return (
    <div className="border border-border rounded-lg overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => { if (showToggle) setExpanded(!expanded); }}
        className={`w-full flex items-center justify-between px-4 py-2.5 bg-muted/50 transition-colors text-left ${showToggle ? 'hover:bg-muted' : ''}`}
        aria-expanded={showToggle ? expanded : undefined}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground/85">
          <FileText className="w-4 h-4 text-muted-foreground/75" />
          Ticket Details
        </span>
        {showToggle ? (
          expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground/75" /> : <ChevronRight className="w-4 h-4 text-muted-foreground/75" />
        ) : (
          <span className="w-4 h-4" aria-hidden />
        )}
      </button>

      <div className="px-4 py-3 space-y-3">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          {ticket.requester?.name && (
            <div className="flex items-start gap-1.5">
              <User className="w-3.5 h-3.5 text-muted-foreground/75 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground/75 uppercase font-medium">Requester</p>
                <p className="text-xs font-medium text-foreground truncate">{ticket.requester.name}</p>
              </div>
            </div>
          )}
          {ticket.requester?.email && (
            <div className="flex items-start gap-1.5">
              <Mail className="w-3.5 h-3.5 text-muted-foreground/75 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground/75 uppercase font-medium">Email</p>
                <p className="text-xs text-muted-foreground truncate">{ticket.requester.email}</p>
              </div>
            </div>
          )}
          {ticket.requester?.department && (
            <div className="flex items-start gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-muted-foreground/75 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground/75 uppercase font-medium">Department</p>
                <p className="text-xs text-muted-foreground truncate">{ticket.requester.department}</p>
              </div>
            </div>
          )}
          {(assessedTicketType || freshserviceTicketType) && (
            <div className="flex items-start gap-1.5">
              <FileText className="w-3.5 h-3.5 text-muted-foreground/75 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground/75 uppercase font-medium">Type</p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {assessedTicketType && (
                    <span
                      className="rounded-md bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-200"
                      title={ticketTypeRationale || undefined}
                    >
                      Assessed: {assessedTicketType}
                    </span>
                  )}
                  {freshserviceTicketType && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      FreshService: {freshserviceTicketType}
                    </span>
                  )}
                  {ticketTypeConfidence && (
                    <span className="rounded-md bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-200">
                      {ticketTypeConfidence} confidence
                    </span>
                  )}
                </div>
                {ticketTypeRationale && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{ticketTypeRationale}</p>
                )}
              </div>
            </div>
          )}
          {(ticket.internalCategory || ticket.category || ticket.ticketCategory || hasSuggestedCategory || hasSuggestedSubcategory) && (
            <div className="flex items-start gap-1.5">
              <Tag className="w-3.5 h-3.5 text-muted-foreground/75 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground/75 uppercase font-medium">Category</p>
                {sourceCategoryLabels.length > 0 && (
                  <div className="mt-0.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/75">Legacy Freshservice evidence</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {sourceCategoryLabels.map((label) => (
                        <span key={label} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {assignedTaxonomyLabel && (
                  <div className="mt-1">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/75">Ticket Pulse category</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <span className="rounded-md bg-blue-50 dark:bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-200">
                        {assignedTaxonomyLabel}
                      </span>
                      {ticket.internalCategoryConfidence && (
                        <span className="rounded-md bg-blue-50 dark:bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-200">
                          Confidence: {ticket.internalCategoryConfidence}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {(taxonomyFitText || taxonomyNeedsReview) && (
                  <div className="mt-1">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/75">Category fit</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {ticket.internalCategoryFit && (
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Category: {taxonomyFitLabel(ticket.internalCategoryFit)}
                        </span>
                      )}
                      {ticket.internalSubcategoryFit && (
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                          taxonomyNeedsReview ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200' : 'bg-muted text-muted-foreground'
                        }`}>
                          Subcategory: {taxonomyFitLabel(ticket.internalSubcategoryFit)}
                        </span>
                      )}
                      {taxonomyNeedsReview && (
                        <span className="rounded-md bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-200">
                          Review category
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {(hasSuggestedCategory || hasSuggestedSubcategory || taxonomyNeedsReview) && (
                  <div className={`mt-1.5 rounded-md border px-2 py-1.5 ${
                    hasSuggestedCategory || hasSuggestedSubcategory
                      ? 'border-emerald-100 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/15'
                      : 'border-amber-100 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/15'
                  }`}>
                    <div className={`text-[9px] font-semibold uppercase tracking-wide ${
                      hasSuggestedCategory || hasSuggestedSubcategory ? 'text-emerald-700 dark:text-emerald-200' : 'text-amber-700 dark:text-amber-200'
                    }`}>
                      Category review note
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {hasSuggestedCategory && (
                        <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-200">
                          Category: {ticket.suggestedInternalCategoryName}
                        </span>
                      )}
                      {hasSuggestedSubcategory && (
                        <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-200">
                          Subcategory: {ticket.suggestedInternalSubcategoryName}
                        </span>
                      )}
                      {!hasSuggestedCategory && !hasSuggestedSubcategory && (
                        <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                          No specific subcategory or cleanup suggestion proposed in this run
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Description */}
        {(useHtml || markdownSource) && (
          <div>
            <div className="border-t border-border/60 pt-2.5">
              <p className="text-xs text-muted-foreground/75 uppercase font-medium mb-2">Description</p>
              <div
                className={`relative rounded-md border border-border/60 bg-muted/25 px-3 py-3 sm:px-4 sm:py-4 ${
                  showToggle && !expanded ? 'max-h-72 overflow-hidden' : ''
                }`}
              >
                {useHtml ? (
                  <div
                    ref={htmlHostRef}
                    className="ticket-description-html text-sm text-foreground/85 leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_b]:font-semibold [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_br]:block [&_table]:my-2 [&_th]:border [&_td]:border [&_th]:px-2 [&_td]:px-2 [&_th]:text-left [&_td]:text-sm"
                    dangerouslySetInnerHTML={{ __html: safeHtml }}
                  />
                ) : (
                  <div className="max-w-none">
                    <Markdown remarkPlugins={[remarkGfm]} components={ticketDescriptionMdComponents}>
                      {markdownSource}
                    </Markdown>
                  </div>
                )}
                {showToggle && !expanded && (
                  <div
                    className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 rounded-b-md bg-gradient-to-t from-card via-card/85 to-transparent"
                    aria-hidden
                  />
                )}
              </div>
              {showToggle && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="text-xs text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 font-medium mt-2"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const DECISION_BADGES = {
  pending_review: { label: 'Pending Review', style: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200' },
  approved: { label: 'Approved', style: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200' },
  modified: { label: 'Modified', style: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200' },
  rejected: { label: 'Rejected', style: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200' },
  auto_assigned: { label: 'Auto-Assigned', style: 'bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200' },
  noise_dismissed: { label: 'Noise Dismissed', style: 'bg-muted text-muted-foreground' },
  duplicate_dismissed: { label: 'Duplicate Dismissed', style: 'bg-cyan-50 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-200' },
  priority_only: { label: 'Priority Only', style: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200' },
};

const RUN_STATUS_BADGES = {
  queued: { label: 'Queued', style: 'bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-200' },
  running: { label: 'Running', style: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200' },
  failed: { label: 'Failed', style: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200' },
  cancelled: { label: 'Cancelled', style: 'bg-muted text-muted-foreground' },
  superseded: { label: 'Superseded', style: 'bg-muted text-muted-foreground' },
  skipped_stale: { label: 'Skipped Stale', style: 'bg-muted text-muted-foreground' },
};

const SYNC_BADGES = {
  synced: { label: 'Synced to FreshService', style: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200', icon: '✓' },
  failed: { label: 'Sync failed', style: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200', icon: '✗' },
  dry_run: { label: 'Dry run (not synced)', style: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200', icon: '◑' },
  pending: { label: 'Sync pending', style: 'bg-muted text-muted-foreground', icon: '…' },
  skipped: { label: 'Sync skipped', style: 'bg-muted text-muted-foreground', icon: '–' },
  handled_in_fs: { label: 'Handled in FreshService', style: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200', icon: '↷' },
  read_only_skipped: { label: 'FreshService read-only', style: 'bg-muted text-muted-foreground', icon: '–' },
};

const REASSIGNABLE_DECISIONS = new Set(['approved', 'modified', 'auto_assigned']);
const REASSIGN_BLOCKING_STATUSES = new Set(['closed', 'resolved', 'deleted', 'spam', '4', '5']);
const PRIORITY_AUDIT_TRIGGERS = new Set(['priority_assessment_after_hours', 'priority_assessment_only']);
const DELIVERY_STATUS_STYLES = {
  sent: 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200',
  queued: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200',
  failed: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200',
  skipped: 'bg-muted text-muted-foreground',
};
const DELIVERY_CHANNEL_LABELS = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  phone_call: 'Voice',
};
const DELIVERY_CHANNEL_ICONS = {
  email: Mail,
  sms: MessageSquare,
  whatsapp: MessageSquare,
  phone_call: PhoneCall,
};

function isFreshServiceReadOnlyMessage(value) {
  return /PUT method is not allowed/i.test(String(value || '')) && /method\(s\): GET/i.test(String(value || ''));
}

function isReadOnlyFreshServiceRun(run) {
  const message = run?.syncError
    || run?.priorityWritebackError
    || run?.ticketTypeWritebackError
    || run?.syncPayload?.freshserviceError?.body?.message
    || run?.priorityWritebackPayload?.freshserviceError?.body?.message
    || run?.ticketTypeWritebackPayload?.freshserviceError?.body?.message;
  return isFreshServiceReadOnlyMessage(message);
}

function isHandledInFreshServiceRun(run) {
  return run?.syncPayload?.preflightAbort?.code === 'superseded_assignee';
}

function SyncStatusCard({ run, onSyncComplete, isAdmin = false, workspaceTimezone = 'America/Los_Angeles' }) {
  const [syncing, setSyncing] = useState(false);
  const [localSyncStatus, setLocalSyncStatus] = useState(run.syncStatus);
  const [localSyncedAt, setLocalSyncedAt] = useState(run.syncedAt);
  const [localSyncError, setLocalSyncError] = useState(run.syncError);
  const [result, setResult] = useState(null);
  const handledInFreshService = isHandledInFreshServiceRun(run);
  const readOnlySkipped = isReadOnlyFreshServiceRun(run);
  const effectiveSyncStatus = handledInFreshService
    ? 'handled_in_fs'
    : readOnlySkipped
      ? 'read_only_skipped'
      : localSyncStatus;
  const badge = SYNC_BADGES[effectiveSyncStatus] || SYNC_BADGES.pending;
  const statusTone = effectiveSyncStatus === 'failed'
    ? 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15'
    : effectiveSyncStatus === 'dry_run'
      ? 'border-yellow-200 dark:border-yellow-500/30 bg-yellow-50 dark:bg-yellow-500/15'
      : effectiveSyncStatus === 'synced'
        ? 'border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/15'
        : effectiveSyncStatus === 'handled_in_fs'
          ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15'
          : 'border-border bg-muted/50';

  const handleSync = async (dryRun) => {
    try {
      setSyncing(true);
      setResult(null);
      const res = dryRun ? await assignmentAPI.syncPreview(run.id) : await assignmentAPI.syncRun(run.id);
      const data = res?.data || res;
      setResult(data);
      if (!dryRun && data?.success) {
        setLocalSyncStatus('synced');
        setLocalSyncedAt(new Date().toISOString());
        setLocalSyncError(null);
        onSyncComplete?.();
      } else if (!dryRun && !data?.success) {
        setLocalSyncStatus('failed');
        setLocalSyncError(data?.error || 'Sync failed');
      }
    } catch (err) {
      setResult({ success: false, error: err.message });
      if (!dryRun) {
        setLocalSyncStatus('failed');
        setLocalSyncError(err.message);
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`rounded-lg border p-3 ${statusTone}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.style}`}>{badge.icon} {badge.label}</span>
          {localSyncedAt && <span className="text-xs text-muted-foreground/75">{formatDateTimeInTimezone(localSyncedAt, workspaceTimezone)}</span>}
        </div>
        {isAdmin && (
          <div className="flex gap-1.5">
            {(localSyncStatus === 'dry_run' || (localSyncStatus === 'failed' && !handledInFreshService && !readOnlySkipped)) && (
              <button onClick={() => handleSync(false)} disabled={syncing} className="px-2.5 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                {syncing ? 'Syncing...' : localSyncStatus === 'failed' ? 'Retry Sync' : 'Execute for Real'}
              </button>
            )}
            {!localSyncStatus && (
              <button onClick={() => handleSync(true)} disabled={syncing} className="px-2.5 py-1 border rounded text-xs font-medium hover:bg-muted/50 disabled:opacity-50">
                Preview Sync
              </button>
            )}
          </div>
        )}
      </div>
      {localSyncError && (
        <p className={`text-xs mt-1.5 ${handledInFreshService ? 'text-amber-700 dark:text-amber-200' : readOnlySkipped ? 'text-muted-foreground' : 'text-red-600 dark:text-red-300'}`}>
          {localSyncError}
        </p>
      )}
      {run.syncPayload?.freshserviceError?.body?.errors && (
        <div className="text-xs text-red-500 mt-1 space-y-0.5">
          {run.syncPayload.freshserviceError.body.errors.map((e, i) => (
            <p key={i}>{e.field}: {e.message} ({e.code})</p>
          ))}
        </div>
      )}
      {run.syncPayload?.preflightAbort && (
        <div className="text-xs text-amber-700 dark:text-amber-200 mt-1.5 bg-amber-50 dark:bg-amber-500/15 rounded p-2">
          <strong>Preflight blocked:</strong> {run.syncPayload.preflightAbort.reason}
          {run.syncPayload.preflightAbort.code === 'incompatible_group' && run.syncPayload.preflightAbort.details?.groupName && (
            <span> (group: {run.syncPayload.preflightAbort.details.groupName})</span>
          )}
        </div>
      )}
      {run.syncPayload?.preview && <p className="text-xs text-muted-foreground mt-1.5">Actions: {run.syncPayload.preview}</p>}
      {result && (
        <div className={`mt-2 text-xs p-2 rounded ${result.success ? 'bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200'}`}>
          {result.success ? (result.dryRun ? `Dry run: ${result.preview}` : `Synced: ${result.preview}`) : `Error: ${result.error}`}
        </div>
      )}
    </div>
  );
}

function PriorityAlertAuditCard({ run, workspaceTimezone = 'America/Los_Angeles' }) {
  const deliveries = Array.isArray(run.notificationDeliveries) ? run.notificationDeliveries : [];
  const escalationStep = Array.isArray(run.steps)
    ? run.steps.find((step) => step.stepName === 'after_hours_urgent_escalation')
    : null;
  const hasPriorityWriteback = Boolean(run.priorityWritebackStatus || run.priorityWrittenAt || run.priorityWritebackError);
  const hasTicketTypeWriteback = Boolean(run.ticketTypeWritebackStatus || run.ticketTypeWrittenAt || run.ticketTypeWritebackError);
  const isPriorityAuditRun = PRIORITY_AUDIT_TRIGGERS.has(run.triggerSource);

  if (!deliveries.length && !escalationStep && !hasPriorityWriteback && !hasTicketTypeWriteback && !isPriorityAuditRun) {
    return null;
  }

  const effectivePriorityWritebackStatus = run.priorityWritebackStatus === 'failed' && isReadOnlyFreshServiceRun(run)
    ? 'skipped'
    : run.priorityWritebackStatus;
  const priorityStatusClass = effectivePriorityWritebackStatus === 'synced'
    ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200'
    : effectivePriorityWritebackStatus === 'failed'
      ? 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200'
      : effectivePriorityWritebackStatus === 'dry_run'
        ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-200'
        : 'bg-muted text-muted-foreground';
  const effectiveTicketTypeWritebackStatus = run.ticketTypeWritebackStatus === 'failed' && isReadOnlyFreshServiceRun(run)
    ? 'skipped'
    : run.ticketTypeWritebackStatus;
  const ticketTypeStatusClass = effectiveTicketTypeWritebackStatus === 'synced'
    ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200'
    : effectiveTicketTypeWritebackStatus === 'failed'
      ? 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200'
      : effectiveTicketTypeWritebackStatus === 'dry_run'
        ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-200'
        : 'bg-muted text-muted-foreground';

  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold text-foreground">Assessment and alert audit</h4>
        {isPriorityAuditRun && (
          <span className="rounded-full bg-indigo-100 dark:bg-indigo-500/20 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200">
            {run.triggerSource === 'priority_assessment_after_hours' ? 'After-hours priority pass' : 'Priority-only pass'}
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">FreshService priority writeback</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${priorityStatusClass}`}>
              {effectivePriorityWritebackStatus ? effectivePriorityWritebackStatus.replace(/_/g, ' ') : 'not attempted'}
            </span>
          </div>
          {run.priorityWrittenAt && (
            <p className="mt-1 text-xs text-muted-foreground">Written {formatDateTimeInTimezone(run.priorityWrittenAt, workspaceTimezone)}</p>
          )}
          {run.priorityWritebackPayload?.preview && (
            <p className="mt-1 text-xs text-muted-foreground">{run.priorityWritebackPayload.preview}</p>
          )}
          {run.priorityWritebackError && (
            <p className={`mt-1 text-xs ${effectivePriorityWritebackStatus === 'skipped' ? 'text-muted-foreground' : 'text-red-600 dark:text-red-300'}`}>
              {effectivePriorityWritebackStatus === 'skipped' ? 'FreshService made this ticket read-only before priority could be written.' : run.priorityWritebackError}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">FreshService ticket type</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ticketTypeStatusClass}`}>
              {effectiveTicketTypeWritebackStatus ? effectiveTicketTypeWritebackStatus.replace(/_/g, ' ') : 'not attempted'}
            </span>
          </div>
          {run.ticketTypeWrittenAt && (
            <p className="mt-1 text-xs text-muted-foreground">Written {formatDateTimeInTimezone(run.ticketTypeWrittenAt, workspaceTimezone)}</p>
          )}
          {run.ticketTypeWritebackPayload?.preview && (
            <p className="mt-1 text-xs text-muted-foreground">{run.ticketTypeWritebackPayload.preview}</p>
          )}
          {run.ticketTypeWritebackError && (
            <p className={`mt-1 text-xs ${effectiveTicketTypeWritebackStatus === 'skipped' ? 'text-muted-foreground' : 'text-red-600 dark:text-red-300'}`}>
              {effectiveTicketTypeWritebackStatus === 'skipped' ? 'FreshService made this ticket read-only before type could be written.' : run.ticketTypeWritebackError}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">After-hours urgent escalation</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              deliveries.some((delivery) => delivery.status === 'failed')
                ? 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200'
                : deliveries.some((delivery) => delivery.status === 'sent')
                  ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200'
                  : deliveries.length > 0
                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200'
                    : escalationStep?.status === 'skipped'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-muted text-muted-foreground'
            }`}>
              {deliveries.length > 0
                ? `${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'}`
                : escalationStep?.status || 'no alerts'}
            </span>
          </div>
          {escalationStep?.output?.skipped && (
            <p className="mt-1 text-xs text-muted-foreground">Skipped: {String(escalationStep.output.skipped).replace(/_/g, ' ')}</p>
          )}
          {escalationStep?.errorMessage && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-300">{escalationStep.errorMessage}</p>
          )}
          {!deliveries.length && !escalationStep && (
            <p className="mt-1 text-xs text-muted-foreground">No alert delivery was recorded for this run.</p>
          )}
        </div>
      </div>

      {deliveries.length > 0 && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {deliveries.map((delivery) => {
            const ChannelIcon = DELIVERY_CHANNEL_ICONS[delivery.channel] || MessageSquare;
            return (
              <div key={delivery.id} className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ChannelIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground">{DELIVERY_CHANNEL_LABELS[delivery.channel] || delivery.channel}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${DELIVERY_STATUS_STYLES[delivery.status] || 'bg-muted text-muted-foreground'}`}>
                    {delivery.status}
                  </span>
                  {delivery.provider && <span className="text-[11px] text-muted-foreground/75">{delivery.provider}</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {delivery.recipient || 'No recipient'} · queued {formatDateTimeInTimezone(delivery.queuedAt, workspaceTimezone)}
                  {delivery.sentAt && <> · sent {formatDateTimeInTimezone(delivery.sentAt, workspaceTimezone)}</>}
                </p>
                {delivery.providerMessageId && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground/75">{delivery.providerMessageId}</p>
                )}
                {delivery.error && <p className="mt-1 text-xs text-red-600 dark:text-red-300">{delivery.error}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReassignTicketModal({ run, onClose, onComplete }) {
  const [technicians, setTechnicians] = useState([]);
  const [loadingTechs, setLoadingTechs] = useState(true);
  const [techSearch, setTechSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const recommendations = getRecommendationList(run?.recommendation);
  const currentTechId = run?.ticket?.assignedTechId || run?.assignedTechId || null;
  const currentTechName = run?.ticket?.assignedTech?.name || run?.assignedTech?.name || 'Unassigned';
  const recommendedTechIds = new Set(recommendations.map((rec) => Number(rec.techId)).filter(Boolean));
  const reasonValid = reason.trim().length >= 15;
  const canSubmit = selected?.assignedTechId && reasonValid && !submitting;

  useEffect(() => {
    let cancelled = false;
    setLoadingTechs(true);
    assignmentAPI.getCompetencyTechnicians()
      .then((res) => {
        const data = res?.data || res || [];
        if (!cancelled) setTechnicians(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.message || err.message || 'Could not load technicians');
      })
      .finally(() => {
        if (!cancelled) setLoadingTechs(false);
      });
    return () => { cancelled = true; };
  }, []);

  const filteredTechnicians = technicians.filter((tech) => {
    if (tech.id === currentTechId || recommendedTechIds.has(Number(tech.id))) return false;
    const query = techSearch.trim().toLowerCase();
    if (!query) return true;
    return tech.name?.toLowerCase().includes(query)
      || tech.email?.toLowerCase().includes(query)
      || tech.location?.toLowerCase().includes(query);
  });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await assignmentAPI.reassignRun(run.id, {
        assignedTechId: selected.assignedTechId,
        selectionSource: selected.selectionSource,
        recommendationRank: selected.recommendationRank,
        reason: reason.trim(),
      });
      onComplete?.();
      onClose();
    } catch (err) {
      const apiError = err?.response?.data;
      const details = apiError?.freshserviceError?.body?.errors
        ? ` ${apiError.freshserviceError.body.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`
        : '';
      setError(`${apiError?.message || err.message || 'Reassignment failed'}${details}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden bg-card rounded-lg shadow-xl border border-border flex flex-col">
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-muted-foreground text-xs font-semibold uppercase tracking-wide">
              <UserCog className="w-4 h-4" />
              Reassign Ticket
            </div>
            <h3 className="text-lg font-semibold text-foreground mt-1">{run?.ticket?.subject || 'Ticket'}</h3>
            <p className="text-sm text-muted-foreground mt-1">Current assignee: <span className="font-medium text-foreground/85">{currentTechName}</span></p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md hover:bg-muted text-muted-foreground/75 hover:text-foreground/85">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5">
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">LLM recommendations</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {recommendations.map((rec, index) => {
                const rank = index + 1;
                const isCurrent = Number(rec.techId) === Number(currentTechId);
                const isSelected = selected?.selectionSource === 'recommendation' && selected.recommendationRank === rank;
                return (
                  <button
                    key={`${rec.techId}-${rank}`}
                    type="button"
                    disabled={isCurrent}
                    onClick={() => setSelected({
                      assignedTechId: rec.techId,
                      selectionSource: 'recommendation',
                      recommendationRank: rank,
                      label: rec.techName,
                    })}
                    className={`text-left rounded-lg border p-3 transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                      isSelected ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/15' : 'border-border bg-card hover:border-blue-300 dark:hover:border-blue-500/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-muted-foreground">#{rank}</span>
                      {typeof rec.score === 'number' && <span className="text-[11px] text-muted-foreground/75">{Math.round(rec.score * 100)}%</span>}
                    </div>
                    <p className="font-semibold text-sm text-foreground mt-1 truncate">{rec.techName}</p>
                    {isCurrent && <p className="text-xs text-amber-600 dark:text-amber-300 mt-1">Already assigned</p>}
                    {rec.reasoning && <p className="text-xs text-muted-foreground mt-2 max-h-14 overflow-hidden">{rec.reasoning}</p>}
                  </button>
                );
              })}
              {recommendations.length === 0 && (
                <div className="md:col-span-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No LLM recommendations were stored for this run.
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Other technician</h4>
              {selected?.selectionSource === 'manual' && (
                <span className="text-xs text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/15 px-2 py-1 rounded-full">{selected.label}</span>
              )}
            </div>
            <div className="relative mb-2">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/75" />
              <input
                type="text"
                value={techSearch}
                onChange={(e) => setTechSearch(e.target.value)}
                placeholder="Search active technicians..."
                className="w-full pl-9 pr-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30 focus:border-blue-300 dark:focus:border-blue-500/40"
              />
            </div>
            <div className="max-h-44 overflow-y-auto border border-border rounded-lg divide-y divide-border/60">
              {loadingTechs ? (
                <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading technicians...
                </div>
              ) : filteredTechnicians.length > 0 ? (
                filteredTechnicians.map((tech) => {
                  const isSelected = selected?.selectionSource === 'manual' && selected.assignedTechId === tech.id;
                  return (
                    <button
                      key={tech.id}
                      type="button"
                      onClick={() => setSelected({
                        assignedTechId: tech.id,
                        selectionSource: 'manual',
                        recommendationRank: null,
                        label: tech.name,
                      })}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-muted/50 ${isSelected ? 'bg-blue-50 dark:bg-blue-500/15' : 'bg-card'}`}
                    >
                      {tech.photoUrl ? (
                        <img src={tech.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                      ) : (
                        <span className="w-8 h-8 rounded-full bg-muted text-muted-foreground text-xs font-bold flex items-center justify-center">
                          {tech.name?.split(' ').map((part) => part[0]).join('').slice(0, 2) || '?'}
                        </span>
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-foreground truncate">{tech.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">{tech.email || tech.location || ''}</span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="p-4 text-sm text-muted-foreground">No matching technicians.</div>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 block">Correction reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full min-h-[96px] border border-border rounded-lg p-3 text-sm resize-y focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30 focus:border-blue-300 dark:focus:border-blue-500/40"
              placeholder="Required. Explain why this ticket belongs with the selected technician so future AI routing can learn from the correction."
            />
            <p className={`mt-1 text-xs ${reasonValid ? 'text-muted-foreground/75' : 'text-amber-600 dark:text-amber-300'}`}>
              Minimum 15 characters. This is saved as assignment feedback and a private Freshservice note.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 p-3 text-sm text-red-700 dark:text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2 bg-muted/50">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-md border border-border bg-card hover:bg-muted/50">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Reassign in Freshservice
          </button>
        </div>
      </div>
    </div>
  );
}

function TranscriptSection({ transcript }) {
  const [expanded, setExpanded] = useState(false);

  if (!transcript) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-foreground/85 mb-2">Full Conversation</h4>
        <div className="border rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
          No full transcript was captured for this run.
        </div>
      </div>
    );
  }

  const markdown = prepareRunTranscriptMarkdown(transcript);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-foreground/85">Full Conversation</h4>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 font-medium flex items-center gap-1"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div className="rounded-lg border border-border bg-card shadow-sm transition-all">
        <div
          className={`${expanded ? '' : 'max-h-[500px] overflow-y-auto overscroll-contain'} scroll-smooth`}
        >
          <div className="px-4 py-5 sm:px-6 sm:py-6 max-w-none [&>*:first-child]:mt-0">
            <Markdown remarkPlugins={[remarkGfm]} components={transcriptMdComponents}>
              {markdown}
            </Markdown>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PipelineRunDetail({ run, onDecide, deciding, onSyncComplete, isAdmin = false, workspaceTimezone = 'America/Los_Angeles' }) {
  const location = useLocation();
  const navigate = useNavigate();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [fsDomain, setFsDomain] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [freshnessLoading, setFreshnessLoading] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);

  useEffect(() => {
    assignmentAPI.getFreshServiceDomain().then(res => setFsDomain(res?.domain)).catch(() => {});
  }, []);

  const isPending = run?.decision === 'pending_review' && run?.status === 'completed';

  useEffect(() => {
    if (!run?.id || !isPending) return;
    setFreshnessLoading(true);
    assignmentAPI.getRunFreshness(run.id)
      .then((res) => setFreshness(res?.data || null))
      .catch(() => setFreshness(null))
      .finally(() => setFreshnessLoading(false));
  }, [run?.id, isPending]);

  if (!run) return null;

  const ticket = run.ticket;
  const normalizedRecommendation = withNormalizedRecommendations(run.recommendation);
  const verifiedRebound = isVerifiedReboundContext(run.reboundFrom);
  const unverifiedRebound = Boolean(run.reboundFrom) && !verifiedRebound;
  // If the run is pending_review but the ticket has been assigned externally
  // in FS, show a clearer "Handled in FS" badge instead of the misleading
  // "Pending Review" — no human action is needed in the app. This stays
  // accurate even for Closed/Resolved tickets: the ticket was handled
  // manually, and the label should reflect that regardless of its current
  // status. Mirrors getDisplayDecision in the list view so the badge is
  // consistent across pages.
  const externallyAssigned = run.status === 'completed'
    && run.decision === 'pending_review'
    && ticket?.assignedTechId;
  const syncedAssignmentDecision = run.syncStatus === 'synced'
    && REASSIGNABLE_DECISIONS.has(run.decision)
    && (run.assignedTechId || ticket?.assignedTechId);
  const decisionBadge = externallyAssigned
    ? { label: 'Handled in FS', style: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200' }
    : (run.status === 'completed' || syncedAssignmentDecision)
      ? (DECISION_BADGES[run.decision] || DECISION_BADGES.pending_review)
      : (RUN_STATUS_BADGES[run.status] || RUN_STATUS_BADGES.running);

  const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
  const PRIORITY_PILL = { 1: 'bg-muted text-muted-foreground', 2: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200', 3: 'bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-200', 4: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200' };
  const PRIORITY_ICON_CLASS = {
    1: 'border-border bg-muted/50 text-muted-foreground/75',
    2: 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300',
    3: 'border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 text-orange-600 dark:text-orange-300',
    4: 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300',
  };
  const PRIORITY_SIGNAL_LABEL = { 1: 'LOW', 2: 'MED', 3: 'HIGH', 4: 'URG' };
  const PRIORITY_ID_BY_LABEL = { Low: 1, Medium: 2, High: 3, Urgent: 4 };
  const assessedPriorityId = Number(ticket?.assessedPriorityId) || PRIORITY_ID_BY_LABEL[ticket?.assessedPriority] || null;
  const assessedPriorityLabel = ticket?.assessedPriority || (assessedPriorityId ? PRIORITY_LABELS[assessedPriorityId] : null);
  const freshservicePriorityLabel = PRIORITY_LABELS[ticket?.priority] || (ticket?.priority ? `P${ticket.priority}` : '—');
  const prioritySignalId = assessedPriorityId || Number(ticket?.priority) || null;
  const prioritySignalTitle = [
    assessedPriorityLabel ? `Ticket Pulse priority: ${assessedPriorityLabel}` : `FreshService priority: ${freshservicePriorityLabel}`,
    ticket?.priorityRationale,
    assessedPriorityId && Number(ticket?.priority) && assessedPriorityId !== Number(ticket.priority)
      ? `FreshService: ${freshservicePriorityLabel}`
      : null,
  ].filter(Boolean).join(' - ');
  const webhookIngestedAt = ticket?.lastWebhookIngestedAt || (run.triggerSource === 'webhook' ? ticket?.lastIngestedAt || run.createdAt : null);
  const sourceSignal = (() => {
    if (webhookIngestedAt || run.triggerSource === 'webhook') {
      return {
        label: 'Webhook',
        Icon: Webhook,
        className: 'border-cyan-200 dark:border-cyan-500/30 bg-cyan-50 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-200',
        tooltip: `Ingested by FreshService webhook${webhookIngestedAt ? ` at ${formatDateTimeInTimezone(webhookIngestedAt, workspaceTimezone)}` : ''}${ticket?.webhookIngestCount ? ` (${ticket.webhookIngestCount} accepted webhook ingest${ticket.webhookIngestCount === 1 ? '' : 's'})` : ''}`,
      };
    }
    if (run.triggerSource === 'manual') {
      return {
        label: 'Manual',
        Icon: Play,
        className: 'border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200',
        tooltip: 'Pipeline run was triggered manually.',
      };
    }
    if (run.triggerSource === 'rebound' || run.triggerSource === 'rebound_exhausted') {
      return {
        label: verifiedRebound ? 'Returned' : 'Needs review',
        Icon: RotateCcw,
        className: verifiedRebound
          ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-200'
          : 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200',
        tooltip: verifiedRebound
          ? 'Pipeline run was triggered after a FreshService-confirmed returned ticket.'
          : 'Pipeline run was triggered from older rebound metadata that did not include FreshService return evidence.',
      };
    }
    return {
      label: 'Polling',
      Icon: RefreshCw,
      className: 'border-border bg-muted/50 text-muted-foreground',
      tooltip: `Pipeline run source: ${run.triggerSource || ticket?.lastIngestSource || 'scheduled polling'}.`,
    };
  })();
  const SourceSignalIcon = sourceSignal.Icon;
  const returnedSignalTitle = verifiedRebound
    ? formatReturnedContext(run.reboundFrom, workspaceTimezone)
    : null;

  const ticketUrl = fsDomain && ticket?.freshserviceTicketId ? `https://${fsDomain}/a/tickets/${ticket.freshserviceTicketId}` : null;
  const latestSyncedCorrection = Array.isArray(run.corrections)
    ? run.corrections.find((correction) => correction.freshserviceSyncStatus === 'synced') || null
    : null;
  const currentAssignedTechId = ticket?.assignedTechId || latestSyncedCorrection?.toTechnicianId || run.assignedTechId || null;
  const currentAssignedTechName = ticket?.assignedTech?.name || latestSyncedCorrection?.toTechnician?.name || run.assignedTech?.name || null;
  const originalAssignedTechId = run.assignedTechId || null;
  const originalAssignedTechName = run.assignedTech?.name || null;
  const assignmentWasCorrected = currentAssignedTechId
    && originalAssignedTechId
    && Number(currentAssignedTechId) !== Number(originalAssignedTechId);
  const ticketStatusKey = String(ticket?.status || '').toLowerCase();
  const canReassign = isAdmin
    && (run.status === 'completed' || syncedAssignmentDecision)
    && REASSIGNABLE_DECISIONS.has(run.decision)
    && ticket?.id
    && !REASSIGN_BLOCKING_STATUSES.has(ticketStatusKey);

  const hasFreshnessDiffs = freshness && !freshness.fresh && freshness.diffs?.length > 0;

  // Fallback staleness check using local DB data (shown while freshness loads or if check fails)
  const isTicketStale = !freshness && ticket && (
    (ticket.status && !['Open', 'open', '2', 'Pending', 'pending', '3'].includes(String(ticket.status))) ||
    (ticket.assignedTechId && ticket.assignedTech && isPending)
  );
  const headerCategoryLabel = ticketPulseCategoryLabel(ticket);
  const headerCategoryNeedsReview = ticketCategoryReviewNeeded(ticket);

  // NT-7: re-run is available for ANY run that isn't literally in flight —
  // noise_dismissed, auto_assigned, rejected, approved, failed, … — not just
  // pending_review. The backend keeps terminal runs intact for history and
  // creates a NEW run with the CURRENT published prompt.
  const isInFlight = run?.status === 'queued' || run?.status === 'running';
  const canRerun = isAdmin && !isInFlight;
  const runPromptVersion = run?.promptVersionNumber ?? null;
  const currentPromptVersion = run?.currentPublishedPromptVersion ?? null;
  // NT-8: flag runs decided under a prompt that has since been superseded.
  const promptIsStale = Boolean(runPromptVersion && currentPromptVersion && runPromptVersion < currentPromptVersion);

  const handleRerun = async () => {
    if (rerunning) return;
    const versionLabel = currentPromptVersion ? `v${currentPromptVersion}` : 'the current published version';
    const confirmed = window.confirm(
      `This creates a NEW pipeline run using the CURRENT published prompt (${versionLabel}). The existing run is kept for history.`,
    );
    if (!confirmed) return;
    setRerunning(true);
    try {
      await assignmentAPI.rerunPipeline(run.id);
      // Point the user at the new run: poll until a run newer than this one
      // appears (the run row is created early, well before the LLM finishes).
      const ticketId = run.ticketId ?? ticket?.id;
      const base = location.pathname.includes('/assignments/history') ? '/assignments/history' : '/assignments/run';
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (!mountedRef.current) return;
        try {
          const res = await assignmentAPI.getLatestRunForTicket(ticketId);
          const latest = res?.data;
          if (latest?.id && latest.id !== run.id) {
            if (mountedRef.current) {
              setRerunning(false);
              navigate(`${base}/${latest.id}`);
            }
            return;
          }
        } catch { /* transient — keep polling */ }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (mountedRef.current) window.location.reload();
    } catch {
      if (mountedRef.current) setRerunning(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header: Ticket-first */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span
                className={`inline-flex h-5 min-w-[2rem] items-center justify-center rounded border px-1 text-[9px] font-bold leading-none ${PRIORITY_ICON_CLASS[prioritySignalId] || 'border-border bg-muted/50 text-muted-foreground/75'}`}
                title={prioritySignalTitle}
                aria-label={prioritySignalTitle}
              >
                {PRIORITY_SIGNAL_LABEL[prioritySignalId] || 'PRI'}
              </span>
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded border ${sourceSignal.className}`}
                title={sourceSignal.tooltip}
                aria-label={sourceSignal.label}
              >
                <SourceSignalIcon className="h-3.5 w-3.5" />
              </span>
              {returnedSignalTitle && (
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded border border-rose-200 dark:border-rose-500/30 bg-card text-rose-700 dark:text-rose-200"
                  title={returnedSignalTitle}
                  aria-label="Returned ticket"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </span>
              )}
              <span className="text-xs text-muted-foreground/75 font-mono">#{ticket?.freshserviceTicketId}</span>
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${PRIORITY_PILL[ticket?.priority] || 'bg-muted text-muted-foreground'}`}>
                FS {freshservicePriorityLabel}
              </span>
              {assessedPriorityLabel && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${PRIORITY_PILL[assessedPriorityId] || 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200'}`}
                  title={ticket?.priorityRationale || undefined}
                >
                  TP {assessedPriorityLabel}
                </span>
              )}
              {headerCategoryLabel && (
                <span className="max-w-full truncate rounded bg-blue-50 dark:bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-200">
                  {headerCategoryLabel}
                </span>
              )}
              {headerCategoryNeedsReview && (
                <span className="rounded bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-200">
                  Review category
                </span>
              )}
            </div>
            <h3 className="text-base sm:text-lg font-bold text-foreground leading-snug">
              {ticket?.subject || 'No subject'}
            </h3>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-muted-foreground">
              {ticket?.requester && (
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3" />
                  {ticket.requester.name}
                  {ticket.requester.department && <span className="text-muted-foreground/75">· {ticket.requester.department}</span>}
                </span>
              )}
              <span className="text-muted-foreground/50">·</span>
              <span>{formatDateTimeInTimezone(ticket?.createdAt, workspaceTimezone)}</span>
              {/* Ticket Pulse's own ticket page is the primary destination; FS
                  stays one click away as the small external icon. */}
              {(ticket?.id || ticketUrl) && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  {ticket?.id ? (
                    <span className="flex items-center gap-1">
                      <Link
                        to={`/tickets/${ticket.id}`}
                        state={{ from: `${location.pathname}${location.search}` }}
                        className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 font-medium"
                      >
                        Open ticket
                      </Link>
                      {ticketUrl && (
                        <a
                          href={ticketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open in FreshService"
                          className="flex-shrink-0 text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300"
                        >
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      )}
                    </span>
                  ) : (
                    <a href={ticketUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 font-medium flex items-center gap-0.5">
                      Open in FreshService <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground/75">
              <CopyBadge label="Run" value={run.id} />
              <span>· {run.triggerSource}</span>
              <span>· {formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}</span>
              <span>· {workspaceTimezone}</span>
              {run.totalDurationMs && <span>· {(run.totalDurationMs / 1000).toFixed(1)}s</span>}
              {run.totalTokensUsed && <span>· {run.totalTokensUsed.toLocaleString()} tokens</span>}
              {(run.llmProvider || run.llmModel) && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-muted-foreground">
                  {[run.llmProvider, run.llmModel].filter(Boolean).join(' · ')}
                </span>
              )}
              {run.llmFallbackUsed && (
                <span className="rounded bg-yellow-50 dark:bg-yellow-500/15 px-1.5 py-0.5 font-semibold text-yellow-700 dark:text-yellow-200">
                  fallback used
                </span>
              )}
              {runPromptVersion && (
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${promptIsStale ? 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200' : 'bg-muted text-muted-foreground'}`}
                  title={promptIsStale ? `Prompt v${currentPromptVersion} is now published` : 'Prompt version this run used'}
                >
                  prompt v{runPromptVersion}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canRerun && (
              <button
                type="button"
                onClick={handleRerun}
                disabled={rerunning}
                title="Creates a new pipeline run for this ticket using the current published prompt. This run is kept for history."
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-input bg-card text-foreground/85 hover:bg-muted disabled:opacity-50 shadow-sm tp-focus-ring"
              >
                {rerunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {rerunning ? 'Starting new run…' : 'Re-run'}
              </button>
            )}
            {canReassign && (
              <button
                type="button"
                onClick={() => setShowReassignModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
              >
                <UserCog className="w-3.5 h-3.5" />
                Reassign
              </button>
            )}
            {assignmentWasCorrected && (
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200">
                Reassigned
              </span>
            )}
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${decisionBadge.style}`}>
              {decisionBadge.label}
            </span>
          </div>
        </div>
      </div>

      {showReassignModal && (
        <ReassignTicketModal
          run={run}
          onClose={() => setShowReassignModal(false)}
          onComplete={onSyncComplete}
        />
      )}

      {/* NT-8: stale-prompt banner — this run was decided under a prompt that
          has since been superseded by a newer published version. */}
      {promptIsStale && (
        <div className="bg-violet-50 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <FileText className="w-5 h-5 text-violet-500 dark:text-violet-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-violet-800 dark:text-violet-200">
              This run used prompt v{runPromptVersion}; v{currentPromptVersion} is now published — results may differ.
            </p>
            {canRerun && (
              <button
                type="button"
                onClick={handleRerun}
                disabled={rerunning}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 tp-focus-ring"
              >
                {rerunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {rerunning ? 'Starting new run…' : 'Re-run with current prompt'}
              </button>
            )}
          </div>
        </div>
      )}

      {assignmentWasCorrected && (
        <div className="bg-green-50 dark:bg-green-500/15 border border-green-200 dark:border-green-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-green-800 dark:text-green-200">
              Current assignee: {currentAssignedTechName}
            </p>
            <p className="text-xs text-green-700 dark:text-green-200 mt-1">
              Originally routed to <span className="font-semibold">{originalAssignedTechName}</span>
              {latestSyncedCorrection?.createdAt && <>; corrected at {formatDateTimeInTimezone(latestSyncedCorrection.createdAt, workspaceTimezone)}</>}.
              {latestSyncedCorrection?.selectionSource === 'recommendation' && latestSyncedCorrection?.recommendationRank && (
                <> The correction used LLM recommendation #{latestSyncedCorrection.recommendationRank}.</>
              )}
            </p>
          </div>
        </div>
      )}

      {assessedPriorityLabel && (
        <div className="bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">
              Ticket Pulse assessed priority: {assessedPriorityLabel}
              {ticket?.priorityConfidence && <span className="font-medium"> ({ticket.priorityConfidence} confidence)</span>}
            </p>
            {ticket?.priorityRationale && (
              <p className="mt-1 text-xs leading-relaxed text-blue-700 dark:text-blue-200">{ticket.priorityRationale}</p>
            )}
            {ticket?.priorityEvidence && Array.isArray(ticket.priorityEvidence) && ticket.priorityEvidence.length > 0 && (
              <p className="mt-1 text-xs text-blue-600 dark:text-blue-300">
                Signals: {ticket.priorityEvidence.slice(0, 4).join(', ')}
              </p>
            )}
            {assessedPriorityId && Number(ticket?.priority) && assessedPriorityId !== Number(ticket.priority) && (
              <p className="mt-1 text-xs text-blue-600 dark:text-blue-300">FreshService currently shows {freshservicePriorityLabel}.</p>
            )}
          </div>
        </div>
      )}

      <PriorityAlertAuditCard run={run} workspaceTimezone={workspaceTimezone} />

      {run.llmFallbackUsed && (
        <div className="bg-yellow-50 dark:bg-yellow-500/15 border border-yellow-200 dark:border-yellow-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
              AI provider fallback used{run.llmProvider ? ` — completed with ${run.llmProvider}` : ''}
            </p>
            <p className="text-xs text-yellow-700 dark:text-yellow-200 mt-1">
              {run.llmFallbackReason || 'The primary provider was unavailable or returned a retryable error.'}
              {Array.isArray(run.aiProviderAttempts) && run.aiProviderAttempts.length > 0 && (
                <> Attempts: {run.aiProviderAttempts.map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.status}`).join('; ')}.</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Rebound / auto-fallback context strip — surfaces why this run exists.
          Two flavors: ongoing rebound (amber) vs auto-fallback exhausted (red). */}
      {run.triggerSource === 'rebound_exhausted' ? (
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <OctagonAlert className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">
              Auto-fallback exhausted{run.reboundFrom?.reboundCount ? ` after ${run.reboundFrom.reboundCount - 1} rebound${run.reboundFrom.reboundCount - 1 === 1 ? '' : 's'}` : ''} — needs manual review
            </p>
            <p className="text-xs text-red-700 dark:text-red-200 mt-1">
              This ticket has been rejected by every technician auto-assigned so far. The system stopped re-routing it automatically. Please assign it manually or dismiss it.
              {verifiedRebound && run.reboundFrom?.previousTechName && run.reboundFrom.previousTechName !== 'Unknown' && (
                <> Most recently returned by <span className="font-semibold">{run.reboundFrom.previousTechName}</span>{run.reboundFrom.unassignedAt && <> at {formatDateTimeInTimezone(run.reboundFrom.unassignedAt, workspaceTimezone)}</>}.</>
              )}
            </p>
          </div>
        </div>
      ) : verifiedRebound && (run.reboundFrom.previousTechName || run.reboundFrom.reboundCount) ? (
        <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <RotateCcw className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Rebound{run.reboundFrom.reboundCount ? ` #${run.reboundFrom.reboundCount}` : ''}
              {run.reboundFrom.previousTechName && run.reboundFrom.previousTechName !== 'Unknown' && (
                <> — returned from <span className="font-semibold">{run.reboundFrom.previousTechName}</span></>
              )}
              {run.reboundFrom.unassignedAt && <> at {formatDateTimeInTimezone(run.reboundFrom.unassignedAt, workspaceTimezone)}</>}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-200 mt-1">
              The previous assignee returned this ticket to the queue. The pipeline re-ran with explicit instructions to avoid re-suggesting them.
              {run.reboundFrom.unassignedByName && run.reboundFrom.unassignedByName !== run.reboundFrom.previousTechName && (
                <> Unassigned by <span className="font-semibold">{run.reboundFrom.unassignedByName}</span>.</>
              )}
            </p>
          </div>
        </div>
      ) : unverifiedRebound ? (
        <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Assignment state changed during sync
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-200 mt-1">
              This older run has rebound metadata, but no FreshService return activity was recorded. Treat FreshService as the source of truth before acting on this recommendation.
            </p>
          </div>
        </div>
      ) : null}

      {/* Group-exclusion strip — fires when _executeRun downgraded an
          auto-assigned run to pending_review because the ticket's FS group
          is on the workspace's excluded-from-auto-assign list. We key on the
          errorMessage prefix written by the backend; it always starts with
          "Group " and contains "excluded from auto-assignment". */}
      {run.decision === 'pending_review' && typeof run.errorMessage === 'string'
        && run.errorMessage.startsWith('Group ')
        && run.errorMessage.includes('excluded from auto-assignment') && (
        <div className="bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <ShieldCheck className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">Manual approval required</p>
            <p className="text-xs text-blue-700 dark:text-blue-200 mt-1">
              {run.errorMessage} The AI recommendation below is ready for your review — no auto-assignment will happen until you approve.
            </p>
          </div>
        </div>
      )}

      {/* Ticket Details + AI Reasoning side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4 items-start">
        <div className="lg:col-span-3">
          <TicketDetailsCard ticket={ticket} recommendation={normalizedRecommendation} />
        </div>
        {normalizedRecommendation?.overallReasoning && (
          <div className="lg:col-span-2">
            <ReasoningCard
              reasoning={normalizedRecommendation.overallReasoning}
              recommendations={normalizedRecommendation.recommendations}
            />
          </div>
        )}
      </div>

      {/* Public note preview — exactly what gets posted to FreshService for the assignee. */}
      {normalizedRecommendation && (run.decision === 'auto_assigned' || run.decision === 'pending_review' || run.decision === 'approved' || run.decision === 'modified' || run.decision === 'noise_dismissed') && (
        <AgentBriefingCard recommendation={normalizedRecommendation} decision={run.decision} />
      )}

      {/* Handoff history strip — shows every pickup/rejection/reassignment for this ticket */}
      {ticket?.id && (
        <HandoffHistoryStrip
          ticketId={ticket.id}
          freshserviceTicketId={ticket.freshserviceTicketId}
          workspaceTimezone={workspaceTimezone}
        />
      )}

      {/* Deleted ticket banner */}
      {String(ticket?.status || '').toLowerCase() === 'deleted' && isPending && (
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">This ticket has been deleted from FreshService.</p>
            <p className="text-xs text-red-600 dark:text-red-300 mt-1">You can dismiss this run or reject the recommendation.</p>
          </div>
        </div>
      )}

      {/* Live freshness banner (replaces old isTicketStale) */}
      {freshnessLoading && isPending && String(ticket?.status || '').toLowerCase() !== 'deleted' && (
        <div className="bg-muted/50 border border-border rounded-lg p-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Checking live FreshService state...
        </div>
      )}

      {hasFreshnessDiffs && isPending && String(ticket?.status || '').toLowerCase() !== 'deleted' && (
        <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1.5">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Ticket state has changed since this run</p>

              {freshness.diffs.includes('assignee_changed') && freshness.currentAssigneeName && (
                <p className="text-sm text-amber-700 dark:text-amber-200">
                  Ticket is now assigned to <strong>{freshness.currentAssigneeName}</strong>{' '}
                  (was {ticket?.assignedTech?.name ? ticket.assignedTech.name : 'unassigned'} at run time).
                </p>
              )}

              {freshness.diffs.includes('rejected_by_recommended_tech') && (
                <p className="text-sm text-amber-700 dark:text-amber-200">
                  <strong>{freshness.recommendedTechName}</strong> already held and rejected this ticket
                  {freshness.rejectionHistory?.find(r => r.techId === freshness.recommendedTechId)?.rejectedAt
                    ? ` at ${formatDateTimeInTimezone(freshness.rejectionHistory.find(r => r.techId === freshness.recommendedTechId).rejectedAt, workspaceTimezone)}`
                    : ''
                  }
                   — re-assigning may be undone.
                </p>
              )}

              {freshness.diffs.includes('group_incompatible') && (
                <p className="text-sm text-amber-700 dark:text-amber-200">
                  Ticket is in group <strong>{freshness.currentGroupName}</strong>;{' '}
                  <strong>{freshness.recommendedTechName}</strong> is not a member of that group.
                </p>
              )}

              {freshness.rejectionHistory?.length > 0 && (
                <div className="text-xs text-amber-600 dark:text-amber-300 mt-1">
                  Rejection history: {freshness.rejectionHistory.map((r, i) => (
                    <span key={i}>{i > 0 ? ', ' : ''}{r.techName} ({formatDateTimeInTimezone(r.rejectedAt, workspaceTimezone)})</span>
                  ))}
                </div>
              )}

              {isAdmin && (
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleRerun}
                    disabled={rerunning}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                  >
                    {rerunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Refresh & re-rank
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fallback local staleness banner (while freshness loads or if check unavailable) */}
      {isTicketStale && isPending && String(ticket?.status || '').toLowerCase() !== 'deleted' && (
        <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            {ticket.assignedTech && (
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                This ticket was assigned to <strong>{ticket.assignedTech.name}</strong> outside of this pipeline.
              </p>
            )}
            {ticket.status && !['Open', 'open', '2'].includes(String(ticket.status)) && (
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                This ticket is now <strong>{ticket.status}</strong> — it may have been resolved or closed.
              </p>
            )}
            <p className="text-xs text-amber-600 dark:text-amber-300 mt-1">You can still approve the recommendation, dismiss this run, or add a triage note.</p>
          </div>
        </div>
      )}

      {run.status !== 'completed' && syncedAssignmentDecision && (
        <div className="bg-green-50 dark:bg-green-500/15 border border-green-200 dark:border-green-500/30 rounded-lg p-3 text-sm text-green-800 dark:text-green-200">
          FreshService sync completed for this assignment, but the pipeline status is still <strong>{run.status}</strong>.
          {run.errorMessage ? ` Finalization warning: ${run.errorMessage}` : ''}
        </div>
      )}

      {run.status !== 'completed' && !syncedAssignmentDecision && (
        <div className="bg-yellow-50 dark:bg-yellow-500/15 border border-yellow-200 dark:border-yellow-500/30 rounded-lg p-3 text-sm text-yellow-800 dark:text-yellow-200">
          This run is in status <strong>{run.status}</strong>.
          {run.errorMessage ? ` ${run.errorMessage}` : ''}
        </div>
      )}

      {/* FreshService Sync Status */}
      {run.syncStatus && (
        <SyncStatusCard run={run} onSyncComplete={onSyncComplete} isAdmin={isAdmin} workspaceTimezone={workspaceTimezone} />
      )}

      {/* Recommendations + Decision (shared component) */}
      {normalizedRecommendation && (
        <RecommendationCards
          data={normalizedRecommendation}
          onDecide={isPending ? onDecide : null}
          deciding={deciding}
          hideReasoning={!!normalizedRecommendation?.overallReasoning}
          hideAgentBriefing
          decision={run.decision}
          currentAssignedTechId={currentAssignedTechId}
          originalAssignedTechId={originalAssignedTechId}
        />
      )}

      {/* Decided info */}
      {run.decidedAt && (
        <div className="bg-muted/50 border rounded-lg p-3 text-sm">
          <p><span className="text-muted-foreground">Decided by:</span> {run.decidedByEmail}</p>
          <p><span className="text-muted-foreground">At:</span> {formatDateTimeInTimezone(run.decidedAt, workspaceTimezone)}</p>
          {run.assignedTech && <p><span className="text-muted-foreground">Original AI assignment:</span> {run.assignedTech.name}</p>}
          {currentAssignedTechName && (
            <p>
              <span className="text-muted-foreground">Current assignee:</span>{' '}
              <span className={assignmentWasCorrected ? 'font-semibold text-green-700 dark:text-green-200' : ''}>{currentAssignedTechName}</span>
            </p>
          )}
          {run.overrideReason && <p><span className="text-muted-foreground">Override reason:</span> {run.overrideReason}</p>}
          {run.decisionNote && <p><span className="text-muted-foreground">Triage note:</span> {run.decisionNote}</p>}
        </div>
      )}

      {run.corrections?.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-500/15 border border-blue-100 dark:border-blue-500/20 rounded-lg p-3 text-sm">
          <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-200 uppercase tracking-wide mb-2">Assignment corrections</h4>
          <div className="space-y-2">
            {run.corrections.map((correction) => (
              <div key={correction.id} className="border border-blue-100 dark:border-blue-500/20 bg-card rounded-md p-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-foreground">
                    {correction.fromTechnician?.name || 'Unassigned'} → {correction.toTechnician?.name}
                  </span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                    correction.freshserviceSyncStatus === 'synced'
                      ? 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200'
                      : correction.freshserviceSyncStatus === 'failed'
                        ? 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200'
                        : 'bg-muted text-muted-foreground'
                  }`}>
                    {correction.freshserviceSyncStatus}
                  </span>
                  <span className="text-xs text-muted-foreground/75">
                    {formatDateTimeInTimezone(correction.createdAt, workspaceTimezone)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{correction.reason}</p>
                {correction.freshserviceSyncError && (
                  <p className="text-xs text-red-600 dark:text-red-300 mt-1">{correction.freshserviceSyncError}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full Conversation */}
      <TranscriptSection transcript={run.fullTranscript} />

      {/* Pipeline Steps */}
      <div>
        <h4 className="text-sm font-semibold text-foreground/85 mb-2">Pipeline Steps</h4>
        {run.steps?.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </div>

      {/* Error */}
      {run.errorMessage && (
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-200">
          <strong>Error:</strong> {run.errorMessage}
        </div>
      )}
    </div>
  );
}
