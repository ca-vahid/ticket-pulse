import crypto from 'crypto';
import prisma from './prisma.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';

const IT_WORKSPACE_ID = 1;
const DEFAULT_DURATION_MINUTES = 120;
const FEEDBACK_ITEM_VOTE_TYPE = 'summit_feedback_item';
const FEEDBACK_SUPPORT_VOTE_TYPE = 'summit_feedback_support';
const FEEDBACK_COMMENT_VOTE_TYPE = 'summit_feedback_comment';
const FEEDBACK_VOTE_TYPES = [
  FEEDBACK_ITEM_VOTE_TYPE,
  FEEDBACK_SUPPORT_VOTE_TYPE,
  FEEDBACK_COMMENT_VOTE_TYPE,
];

const clients = new Map();

function makeId(prefix, name) {
  const slug = String(name || 'item')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 58);
  return `${prefix}_${slug || crypto.randomBytes(4).toString('hex')}`;
}

function uniqueRuntimeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sub(name, icon = 'Tag', evidence = '') {
  return {
    id: makeId('sub', name),
    name,
    icon,
    status: 'draft',
    evidence,
    deleted: false,
  };
}

function category(name, icon, color, description, subs, evidence = '') {
  return {
    id: makeId('cat', name),
    name,
    icon,
    color,
    description,
    status: 'draft',
    evidence,
    notes: '',
    deleted: false,
    collapsed: false,
    subcategories: subs,
  };
}

export function getInitialSummitState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    title: 'BGC Engineering IT Summit',
    subtitle: 'IT ticket category workshop',
    lastEditedAt: now,
    workshopMode: 'facilitator',
    categories: [
      category('Account & Access', 'KeyRound', '#0f4c81', 'Accounts, authentication, permissions, group membership, application access, and privileged access.', [
        sub('Password & MFA', 'ShieldCheck', '6 AI-classified tickets.'),
        sub('Active Directory / Entra ID Tasks', 'UsersRound'),
        sub('Account Expiry / Credential Reset', 'RefreshCw'),
        sub('Entra / Azure AD App Registrations', 'CloudCog'),
        sub('Mailbox / Distribution List Membership', 'Mail'),
        sub('Email Forwarding / Auto-Forward Rules', 'Forward'),
        sub('Network Drive / File Share Permissions', 'FolderKey'),
        sub('SharePoint Site Access & Permissions', 'Share2'),
        sub('Microsoft 365 App Permissions', 'BadgeCheck'),
        sub('GitHub / AWS / Developer Platform Access', 'GitBranch'),
        sub('ITSM Tool User Management', 'UserCog'),
        sub('BeyondTrust / Privileged Access Client', 'LockKeyhole'),
      ], 'Renamed from Identity, Access & Permissions using service desk wording.'),
      category('Devices & Hardware', 'MonitorCog', '#2563eb', 'Laptops, desktops, deskside hardware, peripherals, printers, encryption, boardrooms, and physical device support.', [
        sub('Workstation Setup', 'Laptop'),
        sub('Laptop / Desktop Performance Troubleshooting', 'Activity'),
        sub('Hardware Fault / BSOD Troubleshooting', 'Bug'),
        sub('Hardware Failure / Data Recovery', 'HardDrive'),
        sub('BitLocker / Encryption', 'Lock'),
        sub('Docking Stations & Display Connectivity', 'Cable'),
        sub('Monitors / Keyboards / Mice / Cameras', 'MousePointer2'),
        sub('Audio / Microphone Devices', 'Mic'),
        sub('Printers & Scanners', 'Printer'),
        sub('Boardrooms and A/V', 'Projector'),
        sub('HoloLens', 'Glasses'),
      ], 'Consolidates workstation, peripheral, print, A/V, and deskside hardware support.'),
      category('Software & Apps', 'AppWindow', '#7c3aed', 'End-user software support, common productivity apps, app installation, developer tools, and general application troubleshooting.', [
        sub('Microsoft 365 Apps', 'PanelsTopLeft', 'Most repeated AI suggestion.'),
        sub('Developer Tools / General Software Installation', 'TerminalSquare'),
      ], 'Keeps general application support separate from engineering-specific and business-system work.'),
      category('Engineering Apps', 'DraftingCompass', '#6d28d9', 'Specialized engineering, geoscience, GIS, CAD, modelling, and field instrumentation software.', [
        sub('Engineering Software', 'DraftingCompass'),
        sub('OpenGround', 'Layers3'),
        sub('RocScience / GeoStudio / WellCAD / FLAC3D', 'Mountain'),
        sub('GIS Software / ArcGIS / Global Mapper', 'Map'),
        sub('Autodesk / CAD Software', 'PenTool'),
        sub('Engineering & Field Instrumentation Software', 'Gauge'),
      ], 'Separates specialized engineering tools from general software support.'),
      category('Collaboration & Files', 'Share2', '#0891b2', 'Teams, SharePoint, OneDrive, Coreshack, file sharing, file recovery, and collaboration workspace changes.', [
        sub('Microsoft Teams', 'MessagesSquare'),
        sub('OneDrive / SharePoint Sync', 'RefreshCcw'),
        sub('SharePoint / Coreshack', 'Share2'),
        sub('Site Access / Ownership Changes', 'UserRoundCheck'),
        sub('External File Sharing / Large File Transfer', 'Send'),
        sub('File Recovery / Deleted Files', 'Undo2'),
        sub('Teams Collaboration', 'MessagesSquare'),
      ], 'Combines collaboration and file platform work under user-facing language.'),
      category('Network & Remote Access', 'Network', '#0f766e', 'VPN, Wi-Fi, network drives, remote connectivity, ISP issues, and network access troubleshooting.', [
        sub('VPN Client Troubleshooting', 'ShieldCheck'),
        sub('Network Drive Access / GSA Connectivity', 'FolderSymlink'),
        sub('WiFi Infrastructure', 'Wifi'),
        sub('ISP / Connectivity Monitoring', 'Router'),
      ], 'Focused on connectivity and remote access rather than server administration.'),
      category('Cloud & Servers', 'CloudCog', '#4f46e5', 'Cloud platforms, servers, deployments, backups, SMTP/service configuration, automation, and infrastructure operations.', [
        sub('Azure Infrastructure', 'Cloud'),
        sub('AWS Account & Organization Management', 'CloudCog'),
        sub('Application Deployment', 'Rocket'),
        sub('DevOps / Software Team / Cambio', 'GitBranch'),
        sub('Scripting & Automation', 'Bot'),
        sub('Internal Tool Deployment', 'PackageCheck'),
        sub('SMTP / Service Configuration', 'MailCog'),
        sub('VPN and Remote Access Server', 'ServerCog'),
        sub('RDP / Server Access', 'MonitorUp'),
        sub('Server Remote Access Provisioning', 'Server'),
        sub('Network & Server Infrastructure', 'Network'),
        sub('Backup / Restore', 'ArchiveRestore'),
      ], 'Covers infrastructure administration, cloud, server, and deployment work.'),
      category('Security', 'ShieldAlert', '#b42318', 'Phishing, security alerts, account compromise, endpoint and network threats, certificates, and compliance controls.', [
        sub('Phishing / Spam Reports', 'MailWarning'),
        sub('Suspicious Authentication / Account Compromise', 'UserX'),
        sub('Endpoint Threat / C2 Detection', 'Radar'),
        sub('Firewall & Perimeter Security', 'BrickWall'),
        sub('WiFi / Network Security Alert', 'Wifi'),
        sub('Threat Intelligence / Security Advisory', 'Newspaper'),
        sub('SSL / Certificate Management', 'FileKey'),
        sub('Security Alert Triage', 'Siren'),
        sub('Maintenance & Compliance', 'ClipboardCheck'),
        sub('Simulated Phishing / Training', 'GraduationCap'),
      ], 'Shorter name for security, risk, and compliance support.'),
      category('Phones & Mobile', 'Smartphone', '#16a34a', 'Phones, carriers, roaming, phone-number provisioning, mobile fleet coordination, iPads, and MDM support.', [
        sub('Mobile Roaming Plan', 'Plane'),
        sub('Mobile Number Porting / Telephony', 'PhoneForwarded'),
        sub('Teams Phone Number Provisioning', 'PhoneCall'),
        sub('Carrier / Telus Coordination', 'RadioTower'),
        sub('Phone Asset Management', 'Smartphone'),
        sub('iPad / MDM Provisioning', 'Tablet'),
        sub('Device Tracking / Find My', 'MapPinned'),
        sub('Mobile App Purchases & Licensing', 'Smartphone'),
      ], 'User-facing name for telecom and mobile services.'),
      category('Onboarding & Offboarding', 'UsersRound', '#334155', 'Employee starts, moves, exits, workstation readiness, account decommissioning, and hardware return.', [
        sub('Onboarding', 'UserPlus'),
        sub('New Hire Workstation', 'Laptop'),
        sub('Onboarding Status / ETA Follow-up', 'Clock'),
        sub('Offboarding', 'UserMinus'),
        sub('Account Decommissioning', 'UserX'),
        sub('Hardware Return / Collection', 'PackageMinus'),
      ], 'Separates employee lifecycle work from general service desk operations.'),
      category('Procurement & Licensing', 'ShoppingCart', '#c2410c', 'IT purchases, equipment requests, accessories, software licensing, SaaS renewals, AI tools, and asset tracking.', [
        sub('IT Orders and Purchases', 'ShoppingCart'),
        sub('Laptop / Workstation Procurement', 'Laptop'),
        sub('Peripherals / Accessories Procurement', 'Keyboard'),
        sub('Software Licensing', 'BadgeDollarSign'),
        sub('Engineering Software Licensing', 'DraftingCompass'),
        sub('AI Tools / SaaS Licensing', 'Sparkles'),
        sub('Microsoft / Copilot / ChatGPT Licensing', 'MessageSquareCode'),
        sub('Asset Inventory / Tracking', 'Boxes'),
        sub('Personal Device Accessories / Reimbursement Inquiries', 'Receipt'),
      ], 'Shorter name for procurement, licensing, and asset requests.'),
      category('Business Systems', 'BriefcaseBusiness', '#0d9488', 'Business applications and workflow platforms used by internal teams.', [
        sub('Internal Business Apps', 'Blocks'),
        sub('BST', 'BriefcaseBusiness'),
        sub('HR Systems / BambooHR', 'Contact'),
        sub('Power Platform / Power Apps', 'Workflow'),
      ], 'Separates named business systems from general software support.'),
      category('Service Desk & Routing', 'ClipboardList', '#64748b', 'Freshservice administration, process work, notifications, misdirected requests, non-IT routing, and operational housekeeping.', [
        sub('Planned Maintenance / Notifications', 'CalendarClock'),
        sub('IT Administration', 'ClipboardList'),
        sub('Process Governance / Workflow Standardization', 'ListChecks'),
        sub('Projects / Office Moves', 'Building2'),
        sub('Vendor Marketing / Promotional Email', 'Megaphone'),
        sub('FreshService Digest / Trending', 'Newspaper'),
        sub('Non-actionable Notifications', 'BellOff'),
        sub('Misdirected Finance / Administrative Requests', 'CircleDollarSign'),
        sub('Non-IT Request / Route Elsewhere', 'RouteOff'),
      ], 'Replaces the previous noise bucket with a broader routing and operations category.'),
    ],
    parkingLot: [
      { id: makeId('park', 'SharePoint and OneDrive boundary'), text: 'Decide whether OneDrive/SharePoint sync lives under Collaboration or Software.', createdAt: now },
      { id: makeId('park', 'Mobile Devices boundary'), text: 'Decide whether Mobile Devices lives under Endpoint or Telecom.', createdAt: now },
      { id: makeId('park', 'Finance requests boundary'), text: 'Decide whether Finance & Administrative Requests is a real IT category or a misdirected/non-IT route.', createdAt: now },
    ],
    deletedItems: [],
    mergeSuggestions: [],
  };
}

function assertItWorkspace(workspaceId) {
  if (Number(workspaceId) !== IT_WORKSPACE_ID) {
    throw new AuthorizationError('The summit category workshop is currently available only in the IT workspace');
  }
}

function room(sessionId) {
  const key = String(sessionId);
  if (!clients.has(key)) clients.set(key, new Set());
  return clients.get(key);
}

function writeSse(sessionId, res, data) {
  if (res.destroyed || res.writableEnded) {
    room(sessionId).delete(res);
    return false;
  }
  try {
    res.write(data);
    return true;
  } catch {
    room(sessionId).delete(res);
    try {
      res.end();
    } catch {
      // Connection is already closed.
    }
    return false;
  }
}

function attachSseClient(sessionId, res, onCleanup = () => {}) {
  const clientRoom = room(sessionId);
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clientRoom.delete(res);
    onCleanup();
  };

  clientRoom.add(res);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

function broadcast(sessionId, event, payload = {}) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...room(sessionId)]) {
    writeSse(sessionId, res, data);
  }
}

function closePublicStreams(sessionId, event = 'expired', payload = {}) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...room(sessionId)]) {
    try {
      res.write(data);
      res.end();
    } catch {
      // connection is already gone
    }
    room(sessionId).delete(res);
  }
}

async function getVoteSummary(sessionId) {
  const [participantCount, participantRows, grouped, mergeSuggestions, categorySuggestions] = await Promise.all([
    prisma.summitWorkshopParticipant.count({ where: { sessionId } }),
    prisma.summitWorkshopParticipant.findMany({
      where: { sessionId },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        lastSeenAt: true,
        votes: {
          orderBy: { createdAt: 'desc' },
          select: {
            itemId: true,
            itemType: true,
            itemLabel: true,
            voteType: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.summitWorkshopVote.groupBy({
      by: ['itemId', 'itemType', 'itemLabel', 'voteType'],
      where: { sessionId, voteType: { notIn: ['merge_suggestion', 'new_category_suggestion', ...FEEDBACK_VOTE_TYPES] } },
      _count: { _all: true },
      orderBy: { _count: { itemId: 'desc' } },
    }),
    prisma.summitWorkshopVote.findMany({
      where: { sessionId, voteType: 'merge_suggestion' },
      include: { participant: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.summitWorkshopVote.findMany({
      where: { sessionId, voteType: 'new_category_suggestion' },
      include: { participant: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 75,
    }),
  ]);

  return {
    participantCount,
    participantStats: participantRows.map((participant) => {
      const counts = participant.votes.reduce((acc, vote) => {
        acc[vote.voteType] = (acc[vote.voteType] || 0) + 1;
        return acc;
      }, {});
      return {
        id: participant.id,
        displayName: participant.displayName,
        supportCount: counts.support || 0,
        mergeSuggestionCount: counts.merge_suggestion || 0,
        categorySuggestionCount: counts.new_category_suggestion || 0,
        totalCount: participant.votes.length,
        joinedAt: participant.createdAt,
        lastSeenAt: participant.lastSeenAt,
        lastActivityAt: participant.votes[0]?.createdAt || participant.lastSeenAt,
        recentItems: participant.votes.slice(0, 4).map((vote) => ({
          itemId: vote.itemId,
          itemType: vote.itemType,
          itemLabel: vote.itemLabel,
          voteType: vote.voteType,
          createdAt: vote.createdAt,
        })),
      };
    }),
    totals: grouped.map((row) => ({
      itemId: row.itemId,
      itemType: row.itemType,
      itemLabel: row.itemLabel,
      voteType: row.voteType,
      count: row._count._all,
    })),
    mergeSuggestions: mergeSuggestions.map((vote) => ({
      id: vote.id,
      itemId: vote.itemId,
      itemLabel: vote.itemLabel,
      participantName: vote.participant.displayName,
      value: vote.value,
      createdAt: vote.createdAt,
    })),
    categorySuggestions: categorySuggestions.map((vote) => ({
      id: vote.id,
      itemId: vote.itemId,
      itemType: vote.itemType,
      itemLabel: vote.itemLabel,
      participantName: vote.participant.displayName,
      value: vote.value,
      createdAt: vote.createdAt,
    })),
  };
}

async function getFeedbackSummary(sessionId, participantId = null) {
  const [items, supportRows, comments, mySupports] = await Promise.all([
    prisma.summitWorkshopVote.findMany({
      where: { sessionId, voteType: FEEDBACK_ITEM_VOTE_TYPE },
      include: { participant: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 250,
    }),
    prisma.summitWorkshopVote.groupBy({
      by: ['itemId'],
      where: { sessionId, voteType: FEEDBACK_SUPPORT_VOTE_TYPE },
      _count: { _all: true },
    }),
    prisma.summitWorkshopVote.findMany({
      where: { sessionId, voteType: FEEDBACK_COMMENT_VOTE_TYPE },
      include: { participant: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
    participantId
      ? prisma.summitWorkshopVote.findMany({
        where: { sessionId, participantId, voteType: FEEDBACK_SUPPORT_VOTE_TYPE },
        select: { itemId: true },
      })
      : Promise.resolve([]),
  ]);

  const supportByItem = new Map(supportRows.map((row) => [row.itemId, row._count._all]));
  const mySupportSet = new Set(mySupports.map((vote) => vote.itemId));
  const commentsByItem = new Map();
  for (const comment of comments) {
    const parentItemId = comment.value?.parentItemId;
    if (!parentItemId) continue;
    if (!commentsByItem.has(parentItemId)) commentsByItem.set(parentItemId, []);
    commentsByItem.get(parentItemId).push({
      id: comment.id,
      itemId: comment.itemId,
      text: comment.value?.text || '',
      participantId: comment.participantId,
      participantName: comment.participant.displayName,
      createdAt: comment.createdAt,
    });
  }

  const normalizedItems = items.map((item) => {
    const itemComments = commentsByItem.get(item.itemId) || [];
    return {
      id: item.id,
      itemId: item.itemId,
      itemType: item.itemType,
      title: item.itemLabel,
      section: item.value?.section === 'attention' ? 'attention' : 'working',
      note: item.value?.note || '',
      status: item.value?.status || 'active',
      participantId: item.participantId,
      participantName: item.participant.displayName,
      createdAt: item.createdAt,
      supportCount: supportByItem.get(item.itemId) || 0,
      isSupportedByMe: mySupportSet.has(item.itemId),
      commentCount: itemComments.length,
      comments: itemComments,
    };
  });

  return {
    items: normalizedItems,
    counts: {
      working: normalizedItems.filter((item) => item.section === 'working').length,
      attention: normalizedItems.filter((item) => item.section === 'attention').length,
      votes: supportRows.reduce((sum, row) => sum + row._count._all, 0),
      comments: comments.length,
    },
  };
}

async function getParticipantCategoryVoteMap(sessionId, participantId) {
  if (!participantId) return {};
  const rows = await prisma.summitWorkshopVote.findMany({
    where: {
      sessionId,
      participantId,
      voteType: { notIn: ['merge_suggestion', 'new_category_suggestion', ...FEEDBACK_VOTE_TYPES] },
    },
    select: { itemId: true },
  });
  return Object.fromEntries(rows.map((row) => [row.itemId, true]));
}

function publicSession(session) {
  const now = Date.now();
  const expiresAt = session.voteExpiresAt ? new Date(session.voteExpiresAt).getTime() : 0;
  return {
    id: session.id,
    title: session.title,
    state: session.state,
    voteEnabled: session.voteEnabled && expiresAt > now,
    voteExpiresAt: session.voteExpiresAt,
    updatedAt: session.updatedAt,
  };
}

function withVotingState(state, patch) {
  const current = state && typeof state === 'object' ? state : {};
  const currentVoting = current.voting && typeof current.voting === 'object' ? current.voting : {};
  return {
    ...current,
    voting: {
      ...currentVoting,
      ...patch,
    },
  };
}

async function serialize(session) {
  const [snapshots, votes, feedback] = await Promise.all([
    prisma.summitWorkshopSnapshot.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, version: true, label: true, snapshotType: true, createdBy: true, createdAt: true },
    }),
    getVoteSummary(session.id),
    getFeedbackSummary(session.id),
  ]);

  return {
    session,
    snapshots,
    votes,
    feedback,
  };
}

async function findActiveSession(workspaceId) {
  return prisma.summitWorkshopSession.findFirst({
    where: { workspaceId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
  });
}

async function createSession(workspaceId, userEmail) {
  const state = getInitialSummitState();
  const session = await prisma.summitWorkshopSession.create({
    data: {
      workspaceId,
      title: state.title,
      state,
      baselineState: state,
      lastSavedBy: userEmail || null,
      snapshots: {
        create: {
          version: 1,
          label: 'Initial summit category seed',
          snapshotType: 'seed',
          state,
          createdBy: userEmail || null,
        },
      },
    },
  });
  return session;
}

export async function getOrCreateWorkshop(workspaceId, userEmail) {
  assertItWorkspace(workspaceId);
  const existing = await findActiveSession(workspaceId);
  return serialize(existing || await createSession(workspaceId, userEmail));
}

export async function saveWorkshopState(workspaceId, { state, label, snapshotType = 'manual' }, userEmail) {
  assertItWorkspace(workspaceId);
  if (!state || typeof state !== 'object' || !Array.isArray(state.categories)) {
    throw new ValidationError('A valid category workshop state with categories is required');
  }

  const existing = await findActiveSession(workspaceId) || await createSession(workspaceId, userEmail);
  const nextVersion = existing.activeVersion + 1;
  const nextState = { ...state, lastEditedAt: new Date().toISOString() };
  if (existing.state?.voting && typeof existing.state.voting === 'object') {
    nextState.voting = {
      ...nextState.voting,
      ...existing.state.voting,
    };
  }
  const session = await prisma.summitWorkshopSession.update({
    where: { id: existing.id },
    data: {
      state: nextState,
      title: nextState.title || existing.title,
      activeVersion: nextVersion,
      lastSavedBy: userEmail || null,
      snapshots: {
        create: {
          version: nextVersion,
          label: label || (snapshotType === 'autosave' ? 'Autosave' : 'Manual save'),
          snapshotType,
          state: nextState,
          createdBy: userEmail || null,
        },
      },
    },
  });

  broadcast(session.id, 'state', publicSession(session));
  return serialize(session);
}

export async function restoreSnapshot(workspaceId, snapshotId, userEmail) {
  assertItWorkspace(workspaceId);
  const snapshot = await prisma.summitWorkshopSnapshot.findUnique({
    where: { id: Number(snapshotId) },
    include: { session: true },
  });
  if (!snapshot || snapshot.session.workspaceId !== workspaceId) throw new NotFoundError('Snapshot not found');
  return saveWorkshopState(workspaceId, {
    state: snapshot.state,
    label: `Restored snapshot ${snapshot.version}`,
    snapshotType: 'restore',
  }, userEmail);
}

export async function configureVoting(workspaceId, durationMinutes = DEFAULT_DURATION_MINUTES, regenerate = false) {
  assertItWorkspace(workspaceId);
  const existing = await findActiveSession(workspaceId) || await createSession(workspaceId, null);
  const token = regenerate || !existing.voteToken ? crypto.randomBytes(24).toString('hex') : existing.voteToken;
  const startedAt = new Date();
  const duration = Math.max(15, Number(durationMinutes) || DEFAULT_DURATION_MINUTES);
  const voteExpiresAt = new Date(startedAt.getTime() + duration * 60 * 1000);
  if (regenerate && existing.voteToken) {
    closePublicStreams(existing.id, 'expired', {
      message: 'The facilitator regenerated the voting link. Please use the new link.',
    });
    await prisma.$transaction([
      prisma.summitWorkshopVote.deleteMany({
        where: {
          sessionId: existing.id,
          voteType: { notIn: FEEDBACK_VOTE_TYPES },
        },
      }),
      prisma.summitWorkshopParticipant.deleteMany({
        where: {
          sessionId: existing.id,
          votes: { none: { voteType: { in: FEEDBACK_VOTE_TYPES } } },
        },
      }),
    ]);
  }
  const session = await prisma.summitWorkshopSession.update({
    where: { id: existing.id },
    data: {
      voteToken: token,
      voteEnabled: true,
      voteExpiresAt,
      state: withVotingState(existing.state, {
        startedAt: startedAt.toISOString(),
        originalDurationMinutes: duration,
        extendedByMinutes: 0,
        lastExtendedAt: null,
      }),
    },
  });
  broadcast(session.id, 'state', publicSession(session));
  return serialize(session);
}

export async function extendVoting(workspaceId, extensionMinutes = 30) {
  assertItWorkspace(workspaceId);
  const existing = await findActiveSession(workspaceId);
  if (!existing || !existing.voteToken) throw new NotFoundError('Voting session not found');

  const minutes = Math.max(5, Math.min(240, Number(extensionMinutes) || 30));
  const currentExpiryMs = existing.voteExpiresAt ? new Date(existing.voteExpiresAt).getTime() : Date.now();
  const voteExpiresAt = new Date(Math.max(Date.now(), currentExpiryMs) + minutes * 60 * 1000);
  const existingVoting = existing.state?.voting && typeof existing.state.voting === 'object' ? existing.state.voting : {};
  const fallbackStartedAt = existing.voteExpiresAt
    ? new Date(new Date(existing.voteExpiresAt).getTime() - DEFAULT_DURATION_MINUTES * 60 * 1000).toISOString()
    : new Date().toISOString();
  const lastExtendedAt = new Date().toISOString();

  const session = await prisma.summitWorkshopSession.update({
    where: { id: existing.id },
    data: {
      voteEnabled: true,
      voteExpiresAt,
      state: withVotingState(existing.state, {
        startedAt: existingVoting.startedAt || fallbackStartedAt,
        originalDurationMinutes: existingVoting.originalDurationMinutes || DEFAULT_DURATION_MINUTES,
        extendedByMinutes: Number(existingVoting.extendedByMinutes || 0) + minutes,
        lastExtendedAt,
      }),
    },
  });
  broadcast(session.id, 'state', publicSession(session));
  return serialize(session);
}

export async function resetParticipantVotes(workspaceId, participantId) {
  assertItWorkspace(workspaceId);
  const existing = await findActiveSession(workspaceId);
  if (!existing) throw new NotFoundError('Workshop session not found');

  const participant = await prisma.summitWorkshopParticipant.findUnique({
    where: { id: Number(participantId) },
    select: { id: true, sessionId: true, displayName: true, participantKey: true },
  });
  if (!participant || participant.sessionId !== existing.id) throw new NotFoundError('Participant not found');

  await prisma.summitWorkshopVote.deleteMany({
    where: {
      participantId: participant.id,
      voteType: { notIn: FEEDBACK_VOTE_TYPES },
    },
  });

  const votes = await getVoteSummary(existing.id);
  broadcast(existing.id, 'participant-reset', {
    participantId: participant.id,
    participantKey: participant.participantKey,
    displayName: participant.displayName,
  });
  broadcast(existing.id, 'votes', votes);
  return { participant, votes };
}

export async function getSessionByVoteToken(token) {
  const session = await prisma.summitWorkshopSession.findUnique({ where: { voteToken: token } });
  if (!session) throw new NotFoundError('Voting session not found');
  if (!session.voteEnabled || !session.voteExpiresAt || new Date(session.voteExpiresAt).getTime() <= Date.now()) {
    throw new AuthorizationError('This voting link has expired');
  }
  return session;
}

export async function getPublicWorkshop(token, participantKey = null) {
  const session = await getSessionByVoteToken(token);
  const participant = participantKey
    ? await prisma.summitWorkshopParticipant.findFirst({
      where: { sessionId: session.id, participantKey: String(participantKey) },
      select: { id: true },
    })
    : null;
  return {
    session: publicSession(session),
    votes: await getVoteSummary(session.id),
    feedback: await getFeedbackSummary(session.id, participant?.id || null),
  };
}

export async function joinPublicWorkshop(token, displayName, participantKey = null) {
  const session = await getSessionByVoteToken(token);
  const safeName = String(displayName || '').trim().slice(0, 120);
  if (!safeName) throw new ValidationError('Name is required');
  const key = participantKey || crypto.randomBytes(24).toString('hex');
  const participant = await prisma.summitWorkshopParticipant.upsert({
    where: { participantKey: key },
    update: { displayName: safeName, lastSeenAt: new Date() },
    create: { sessionId: session.id, participantKey: key, displayName: safeName },
  });
  const votes = await getVoteSummary(session.id);
  broadcast(session.id, 'votes', votes);
  return { participant, session: publicSession(session), votes };
}

function normalizeFeedbackSection(section) {
  return String(section || '').toLowerCase() === 'attention' ? 'attention' : 'working';
}

function validateFeedbackTitle(title) {
  const safeTitle = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!safeTitle) throw new ValidationError('A short title is required');
  return safeTitle;
}

async function getOrCreateAuthenticatedSummitParticipant(workspaceId, user = {}) {
  assertItWorkspace(workspaceId);
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) throw new AuthorizationError('Sign in is required');

  const isAdmin = user.role === 'admin';
  const profile = (user.agentProfiles || []).find((candidate) => Number(candidate.workspaceId) === IT_WORKSPACE_ID);
  if (!isAdmin && !profile) {
    throw new AuthorizationError('IT Summit 2026 is currently available only to matched IT workspace agents');
  }

  const session = await findActiveSession(workspaceId) || await createSession(workspaceId, email);
  const participantKey = `auth_${session.id}_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
  const displayName = String(profile?.name || user.name || email).trim().slice(0, 120);
  const participant = await prisma.summitWorkshopParticipant.upsert({
    where: { participantKey },
    update: { displayName, lastSeenAt: new Date() },
    create: { sessionId: session.id, participantKey, displayName },
  });
  return { session, participant };
}

export async function getAuthenticatedFeedback(workspaceId, user) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return {
    session: publicSession(session),
    participant,
    feedback: await getFeedbackSummary(session.id, participant.id),
  };
}

export async function getAuthenticatedWorkshop(workspaceId, user) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return {
    session: publicSession(session),
    participant,
    votes: await getVoteSummary(session.id),
    myVotes: await getParticipantCategoryVoteMap(session.id, participant.id),
    feedback: await getFeedbackSummary(session.id, participant.id),
  };
}

export async function getWorkshopFeedback(workspaceId) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId) || await createSession(workspaceId, null);
  return {
    session: publicSession(session),
    feedback: await getFeedbackSummary(session.id),
  };
}

export async function updateFeedbackItem(workspaceId, itemId, body = {}) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId);
  if (!session) throw new NotFoundError('Workshop session not found');

  const item = await prisma.summitWorkshopVote.findFirst({
    where: {
      sessionId: session.id,
      itemId: String(itemId || ''),
      voteType: FEEDBACK_ITEM_VOTE_TYPE,
    },
  });
  if (!item) throw new NotFoundError('Feedback item not found');

  const title = validateFeedbackTitle(body.title ?? item.itemLabel);
  const section = normalizeFeedbackSection(body.section ?? item.value?.section);
  const note = String(body.note ?? item.value?.note ?? '').trim().slice(0, 1500);

  await prisma.summitWorkshopVote.update({
    where: { id: item.id },
    data: {
      itemLabel: title,
      value: {
        ...(item.value || {}),
        section,
        note,
        status: 'active',
        editedAt: new Date().toISOString(),
      },
    },
  });
  await prisma.summitWorkshopVote.updateMany({
    where: {
      sessionId: session.id,
      itemId: item.itemId,
      voteType: FEEDBACK_SUPPORT_VOTE_TYPE,
    },
    data: { itemLabel: title },
  });

  const feedback = await getFeedbackSummary(session.id);
  broadcast(session.id, 'feedback', feedback);
  return { feedback };
}

export async function deleteFeedbackItem(workspaceId, itemId) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId);
  if (!session) throw new NotFoundError('Workshop session not found');

  const item = await prisma.summitWorkshopVote.findFirst({
    where: {
      sessionId: session.id,
      itemId: String(itemId || ''),
      voteType: FEEDBACK_ITEM_VOTE_TYPE,
    },
    select: { itemId: true },
  });
  if (!item) throw new NotFoundError('Feedback item not found');

  const comments = await prisma.summitWorkshopVote.findMany({
    where: { sessionId: session.id, voteType: FEEDBACK_COMMENT_VOTE_TYPE },
    select: { id: true, value: true },
  });
  const commentIds = comments
    .filter((comment) => comment.value?.parentItemId === item.itemId)
    .map((comment) => comment.id);

  await prisma.$transaction([
    ...(commentIds.length
      ? [prisma.summitWorkshopVote.deleteMany({ where: { id: { in: commentIds } } })]
      : []),
    prisma.summitWorkshopVote.deleteMany({
      where: {
        sessionId: session.id,
        itemId: item.itemId,
        voteType: { in: [FEEDBACK_ITEM_VOTE_TYPE, FEEDBACK_SUPPORT_VOTE_TYPE] },
      },
    }),
  ]);

  const feedback = await getFeedbackSummary(session.id);
  broadcast(session.id, 'feedback', feedback);
  return { feedback };
}

export async function deleteFeedbackComment(workspaceId, commentItemId) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId);
  if (!session) throw new NotFoundError('Workshop session not found');

  const result = await prisma.summitWorkshopVote.deleteMany({
    where: {
      sessionId: session.id,
      itemId: String(commentItemId || ''),
      voteType: FEEDBACK_COMMENT_VOTE_TYPE,
    },
  });
  if (!result.count) throw new NotFoundError('Feedback comment not found');

  const feedback = await getFeedbackSummary(session.id);
  broadcast(session.id, 'feedback', feedback);
  return { feedback };
}

export async function resetFeedback(workspaceId) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId);
  if (!session) throw new NotFoundError('Workshop session not found');

  await prisma.summitWorkshopVote.deleteMany({
    where: {
      sessionId: session.id,
      voteType: { in: FEEDBACK_VOTE_TYPES },
    },
  });

  const feedback = await getFeedbackSummary(session.id);
  broadcast(session.id, 'feedback', feedback);
  broadcast(session.id, 'feedback-reset', feedback);
  return { feedback };
}

async function createFeedbackItemForParticipant(session, participant, body = {}) {
  const title = validateFeedbackTitle(body.title);
  const section = normalizeFeedbackSection(body.section);
  const note = String(body.note || '').trim().slice(0, 1500);
  const itemId = uniqueRuntimeId(`summit_feedback_${section}_${participant.id}`);
  await prisma.summitWorkshopVote.create({
    data: {
      sessionId: session.id,
      participantId: participant.id,
      itemId,
      itemType: 'summit_feedback',
      itemLabel: title,
      voteType: FEEDBACK_ITEM_VOTE_TYPE,
      value: {
        section,
        note,
        status: 'active',
      },
    },
  });
  await prisma.summitWorkshopParticipant.update({
    where: { id: participant.id },
    data: { lastSeenAt: new Date() },
  });
  const feedback = await getFeedbackSummary(session.id, participant.id);
  broadcast(session.id, 'feedback', await getFeedbackSummary(session.id));
  return { feedback };
}

async function voteFeedbackForParticipant(session, participant, itemId, active = true) {
  const item = await prisma.summitWorkshopVote.findFirst({
    where: { sessionId: session.id, itemId: String(itemId || ''), voteType: FEEDBACK_ITEM_VOTE_TYPE },
    select: { itemId: true, itemLabel: true },
  });
  if (!item) throw new NotFoundError('Feedback item not found');

  if (active === false) {
    await prisma.summitWorkshopVote.deleteMany({
      where: { participantId: participant.id, itemId: item.itemId, voteType: FEEDBACK_SUPPORT_VOTE_TYPE },
    });
  } else {
    await prisma.summitWorkshopVote.upsert({
      where: {
        participantId_itemId_voteType: {
          participantId: participant.id,
          itemId: item.itemId,
          voteType: FEEDBACK_SUPPORT_VOTE_TYPE,
        },
      },
      update: { itemLabel: item.itemLabel },
      create: {
        sessionId: session.id,
        participantId: participant.id,
        itemId: item.itemId,
        itemType: 'summit_feedback',
        itemLabel: item.itemLabel,
        voteType: FEEDBACK_SUPPORT_VOTE_TYPE,
      },
    });
  }
  await prisma.summitWorkshopParticipant.update({
    where: { id: participant.id },
    data: { lastSeenAt: new Date() },
  });
  const feedback = await getFeedbackSummary(session.id, participant.id);
  broadcast(session.id, 'feedback', await getFeedbackSummary(session.id));
  return { feedback };
}

async function commentFeedbackForParticipant(session, participant, itemId, body = {}) {
  const item = await prisma.summitWorkshopVote.findFirst({
    where: { sessionId: session.id, itemId: String(itemId || ''), voteType: FEEDBACK_ITEM_VOTE_TYPE },
    select: { itemId: true, itemLabel: true, value: true },
  });
  if (!item) throw new NotFoundError('Feedback item not found');

  const text = String(body.text || '').trim().slice(0, 1500);
  if (!text) throw new ValidationError('Comment text is required');
  await prisma.summitWorkshopVote.create({
    data: {
      sessionId: session.id,
      participantId: participant.id,
      itemId: uniqueRuntimeId(`summit_feedback_comment_${participant.id}`),
      itemType: 'summit_feedback_comment',
      itemLabel: item.itemLabel,
      voteType: FEEDBACK_COMMENT_VOTE_TYPE,
      value: {
        parentItemId: item.itemId,
        section: normalizeFeedbackSection(item.value?.section),
        text,
      },
    },
  });
  await prisma.summitWorkshopParticipant.update({
    where: { id: participant.id },
    data: { lastSeenAt: new Date() },
  });
  const feedback = await getFeedbackSummary(session.id, participant.id);
  broadcast(session.id, 'feedback', await getFeedbackSummary(session.id));
  return { feedback };
}

export async function submitAuthenticatedFeedbackItem(workspaceId, user, body) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return createFeedbackItemForParticipant(session, participant, body);
}

export async function voteAuthenticatedFeedbackItem(workspaceId, user, itemId, body = {}) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return voteFeedbackForParticipant(session, participant, itemId, body.active !== false);
}

export async function commentAuthenticatedFeedbackItem(workspaceId, user, itemId, body = {}) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return commentFeedbackForParticipant(session, participant, itemId, body);
}

export async function submitPublicFeedbackItem(token, body) {
  const session = await getSessionByVoteToken(token);
  const participant = await prisma.summitWorkshopParticipant.findUnique({
    where: { participantKey: String(body?.participantKey || '') },
  });
  if (!participant || participant.sessionId !== session.id) throw new AuthorizationError('Join the workshop before submitting feedback');
  return createFeedbackItemForParticipant(session, participant, body);
}

export async function votePublicFeedbackItem(token, itemId, body = {}) {
  const session = await getSessionByVoteToken(token);
  const participant = await prisma.summitWorkshopParticipant.findUnique({
    where: { participantKey: String(body?.participantKey || '') },
  });
  if (!participant || participant.sessionId !== session.id) throw new AuthorizationError('Join the workshop before voting');
  return voteFeedbackForParticipant(session, participant, itemId, body.active !== false);
}

export async function commentPublicFeedbackItem(token, itemId, body = {}) {
  const session = await getSessionByVoteToken(token);
  const participant = await prisma.summitWorkshopParticipant.findUnique({
    where: { participantKey: String(body?.participantKey || '') },
  });
  if (!participant || participant.sessionId !== session.id) throw new AuthorizationError('Join the workshop before commenting');
  return commentFeedbackForParticipant(session, participant, itemId, body);
}

export async function submitVote(token, body) {
  const session = await getSessionByVoteToken(token);
  const participantKey = String(body.participantKey || '');
  const participant = await prisma.summitWorkshopParticipant.findUnique({ where: { participantKey } });
  if (!participant || participant.sessionId !== session.id) throw new AuthorizationError('Join the workshop before voting');
  return submitVoteForParticipant(session, participant, body);
}

async function submitVoteForParticipant(session, participant, body = {}) {
  const voteType = String(body.voteType || 'support').slice(0, 40);
  const itemLabel = String(body.itemLabel || 'Workshop item').slice(0, 255);
  const itemType = String(body.itemType || 'category').slice(0, 30);
  const itemId = ['merge_suggestion', 'new_category_suggestion'].includes(voteType)
    ? uniqueRuntimeId(`${voteType.replace('_suggestion', '')}_${participant.id}`)
    : String(body.itemId || '').slice(0, 120);
  if (!itemId) throw new ValidationError('itemId is required');

  const data = {
    sessionId: session.id,
    participantId: participant.id,
    itemId,
    itemType,
    itemLabel,
    voteType,
    value: body.value || null,
  };

  if (voteType === 'merge_suggestion' || voteType === 'new_category_suggestion') {
    await prisma.summitWorkshopVote.create({ data });
  } else if (body.active === false) {
    await prisma.summitWorkshopVote.deleteMany({
      where: { participantId: participant.id, itemId, voteType },
    });
  } else {
    await prisma.summitWorkshopVote.upsert({
      where: {
        participantId_itemId_voteType: {
          participantId: participant.id,
          itemId,
          voteType,
        },
      },
      update: { itemType, itemLabel, value: body.value || null },
      create: data,
    });
  }

  await prisma.summitWorkshopParticipant.update({
    where: { id: participant.id },
    data: { lastSeenAt: new Date() },
  });
  const votes = await getVoteSummary(session.id);
  broadcast(session.id, 'votes', votes);
  return {
    votes,
    myVotes: await getParticipantCategoryVoteMap(session.id, participant.id),
  };
}

export async function submitAuthenticatedVote(workspaceId, user, body = {}) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  return submitVoteForParticipant(session, participant, body);
}

export async function streamPublicWorkshop(token, res) {
  const session = await getSessionByVoteToken(token);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let keepAlive = null;
  const cleanup = attachSseClient(session.id, res, () => {
    if (keepAlive) clearInterval(keepAlive);
  });
  if (!writeSse(session.id, res, `event: state\ndata: ${JSON.stringify(publicSession(session))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: votes\ndata: ${JSON.stringify(await getVoteSummary(session.id))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: feedback\ndata: ${JSON.stringify(await getFeedbackSummary(session.id))}\n\n`)) return cleanup();
  keepAlive = setInterval(() => {
    if (!writeSse(session.id, res, ': keepalive\n\n')) cleanup();
  }, 25000);
}

export async function streamWorkshopByWorkspace(workspaceId, res) {
  assertItWorkspace(workspaceId);
  const session = await findActiveSession(workspaceId) || await createSession(workspaceId, null);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let keepAlive = null;
  const cleanup = attachSseClient(session.id, res, () => {
    if (keepAlive) clearInterval(keepAlive);
  });
  if (!writeSse(session.id, res, `event: state\ndata: ${JSON.stringify(publicSession(session))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: votes\ndata: ${JSON.stringify(await getVoteSummary(session.id))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: feedback\ndata: ${JSON.stringify(await getFeedbackSummary(session.id))}\n\n`)) return cleanup();
  keepAlive = setInterval(() => {
    if (!writeSse(session.id, res, ': keepalive\n\n')) cleanup();
  }, 25000);
}

export async function streamAuthenticatedFeedback(workspaceId, user, res) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let keepAlive = null;
  const cleanup = attachSseClient(session.id, res, () => {
    if (keepAlive) clearInterval(keepAlive);
  });
  if (!writeSse(session.id, res, `event: feedback\ndata: ${JSON.stringify(await getFeedbackSummary(session.id, participant.id))}\n\n`)) return cleanup();
  keepAlive = setInterval(() => {
    if (!writeSse(session.id, res, ': keepalive\n\n')) cleanup();
  }, 25000);
}

export async function streamAuthenticatedWorkshop(workspaceId, user, res) {
  const { session, participant } = await getOrCreateAuthenticatedSummitParticipant(workspaceId, user);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let keepAlive = null;
  const cleanup = attachSseClient(session.id, res, () => {
    if (keepAlive) clearInterval(keepAlive);
  });
  if (!writeSse(session.id, res, `event: state\ndata: ${JSON.stringify(publicSession(session))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: votes\ndata: ${JSON.stringify(await getVoteSummary(session.id))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: my-votes\ndata: ${JSON.stringify(await getParticipantCategoryVoteMap(session.id, participant.id))}\n\n`)) return cleanup();
  if (!writeSse(session.id, res, `event: feedback\ndata: ${JSON.stringify(await getFeedbackSummary(session.id, participant.id))}\n\n`)) return cleanup();
  keepAlive = setInterval(() => {
    if (!writeSse(session.id, res, ': keepalive\n\n')) cleanup();
  }, 25000);
}

export default {
  getOrCreateWorkshop,
  saveWorkshopState,
  restoreSnapshot,
  configureVoting,
  extendVoting,
  resetParticipantVotes,
  getPublicWorkshop,
  joinPublicWorkshop,
  submitVote,
  getAuthenticatedFeedback,
  getAuthenticatedWorkshop,
  getWorkshopFeedback,
  updateFeedbackItem,
  deleteFeedbackItem,
  deleteFeedbackComment,
  resetFeedback,
  submitAuthenticatedFeedbackItem,
  voteAuthenticatedFeedbackItem,
  commentAuthenticatedFeedbackItem,
  submitAuthenticatedVote,
  submitPublicFeedbackItem,
  votePublicFeedbackItem,
  commentPublicFeedbackItem,
  streamPublicWorkshop,
  streamWorkshopByWorkspace,
  streamAuthenticatedFeedback,
  streamAuthenticatedWorkshop,
};
