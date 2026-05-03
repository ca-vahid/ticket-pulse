import crypto from 'crypto';
import prisma from './prisma.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';

const IT_WORKSPACE_ID = 1;
const DEFAULT_DURATION_MINUTES = 120;

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
    subtitle: 'IT ticket category taxonomy workshop',
    lastEditedAt: now,
    workshopMode: 'facilitator',
    categories: [
      category('Identity, Access & Permissions', 'KeyRound', '#0f4c81', 'Authentication, identity lifecycle, access grants, mailbox/list permissions, SaaS access, and directory/app permission changes.', [
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
      ], 'Permissions Update had 13 AI-classified tickets and repeated Daily Review mentions.'),
      category('Security, Risk & Compliance', 'ShieldAlert', '#b42318', 'Phishing, security alerts, account compromise, endpoint/network threats, certificates, security tooling, and compliance/admin-control work.', [
        sub('Phishing / Spam Reports', 'MailWarning'),
        sub('Suspicious Authentication / Account Compromise', 'UserX'),
        sub('Endpoint Threat / C2 Detection', 'Radar'),
        sub('Firewall & Perimeter Security', 'BrickWall'),
        sub('WiFi / Network Security Alert', 'Wifi'),
        sub('Threat Intelligence / Security Advisory', 'Newspaper'),
        sub('SSL / Certificate Management', 'FileKey'),
        sub('Security Alert Triage', 'Siren'),
        sub('Maintenance & Compliance', 'ClipboardCheck'),
        sub('BeyondTrust / Privileged Access Client', 'LockKeyhole'),
      ], 'Security Incident Response had 14 AI-classified tickets; raw categories include Spam/Phishing, Security Alert, and Security Incident.'),
      category('Endpoint, Workstation & Peripherals', 'MonitorCog', '#2563eb', 'Laptops/desktops, deskside hardware, peripherals, printers, boardrooms, A/V, and physical workstation support.', [
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
      ], 'Workstation Setup, Peripherals, and Printers were repeatedly flagged as needing subcategory coverage.'),
      category('Software & Business Applications', 'AppWindow', '#7c3aed', 'End-user application support, Microsoft apps, engineering/scientific tools, internal business apps, and app-specific troubleshooting.', [
        sub('Microsoft 365 Apps', 'PanelsTopLeft', 'Most repeated AI suggestion.'),
        sub('Microsoft Teams', 'MessagesSquare'),
        sub('OneDrive / SharePoint Sync', 'RefreshCcw'),
        sub('Engineering Software', 'DraftingCompass'),
        sub('OpenGround', 'Layers3'),
        sub('RocScience / GeoStudio / WellCAD / FLAC3D', 'Mountain'),
        sub('GIS Software / ArcGIS / Global Mapper', 'Map'),
        sub('Autodesk / CAD Software', 'PenTool'),
        sub('Engineering & Field Instrumentation Software', 'Gauge'),
        sub('Developer Tools / General Software Installation', 'TerminalSquare'),
        sub('Internal Business Apps', 'Blocks'),
        sub('BST', 'BriefcaseBusiness'),
        sub('HR Systems / BambooHR', 'Contact'),
        sub('Power Platform / Power Apps', 'Workflow'),
      ], 'Software Support was the largest AI-classified category with 42 tickets.'),
      category('Collaboration & Content Platforms', 'Share2', '#0891b2', 'SharePoint/Coreshack, content access, file recovery, collaboration file workflows, and large file-sharing issues.', [
        sub('SharePoint / Coreshack', 'Share2'),
        sub('Site Access / Ownership Changes', 'UserRoundCheck'),
        sub('External File Sharing / Large File Transfer', 'Send'),
        sub('File Recovery / Deleted Files', 'Undo2'),
        sub('OneDrive / SharePoint Sync', 'RefreshCcw'),
        sub('Teams Collaboration', 'MessagesSquare'),
      ], 'SharePoint/Coreshack had 11 AI-classified tickets and repeated Daily Review mentions.'),
      category('Network, Server & Remote Access', 'Network', '#0f766e', 'VPN, RDP/server access, network drives/connectivity, infrastructure, WiFi, ISP, and backup/restore operations.', [
        sub('VPN Client Troubleshooting', 'ShieldCheck'),
        sub('VPN and Remote Access Server', 'ServerCog'),
        sub('RDP / Server Access', 'MonitorUp'),
        sub('Server Remote Access Provisioning', 'Server'),
        sub('Network Drive Access / GSA Connectivity', 'FolderSymlink'),
        sub('Network & Server Infrastructure', 'Network'),
        sub('WiFi Infrastructure', 'Wifi'),
        sub('ISP / Connectivity Monitoring', 'Router'),
        sub('Backup / Restore', 'ArchiveRestore'),
      ], 'Raw FreshService showed Server Infrastructure, Infrastructure, WiFi, Network Infrastructure, and VPN variants.'),
      category('Cloud, DevOps & Platform Engineering', 'CloudCog', '#4f46e5', 'Cloud infrastructure, internal deployments, software team platform work, and automation.', [
        sub('Azure Infrastructure', 'Cloud'),
        sub('AWS Account & Organization Management', 'CloudCog'),
        sub('Application Deployment', 'Rocket'),
        sub('DevOps / Software Team / Cambio', 'GitBranch'),
        sub('Scripting & Automation', 'Bot'),
        sub('Internal Tool Deployment', 'PackageCheck'),
        sub('SMTP / Service Configuration', 'MailCog'),
      ], 'AI suggestions included Azure infrastructure, app registrations, AWS organization management, and application deployment.'),
      category('Procurement, Licensing & Asset Requests', 'ShoppingCart', '#c2410c', 'Purchasing, equipment orders, license changes, SaaS licensing, renewals, asset tracking, and reimbursement-adjacent IT requests.', [
        sub('IT Orders and Purchases', 'ShoppingCart'),
        sub('Laptop / Workstation Procurement', 'Laptop'),
        sub('Peripherals / Accessories Procurement', 'Keyboard'),
        sub('Mobile App Purchases & Licensing', 'Smartphone'),
        sub('Software Licensing', 'BadgeDollarSign'),
        sub('Engineering Software Licensing', 'DraftingCompass'),
        sub('AI Tools / SaaS Licensing', 'Sparkles'),
        sub('Microsoft / Copilot / ChatGPT Licensing', 'MessageSquareCode'),
        sub('Asset Inventory / Tracking', 'Boxes'),
        sub('Personal Device Accessories / Reimbursement Inquiries', 'Receipt'),
      ], 'Licensing and IT Orders/Purchases were both recurring AI and Daily Review categories.'),
      category('Employee Lifecycle & Service Operations', 'UsersRound', '#334155', 'Onboarding/offboarding workflows, NH workstation setup, service process work, and IT operating procedures.', [
        sub('Onboarding', 'UserPlus'),
        sub('New Hire Workstation', 'Laptop'),
        sub('Onboarding Status / ETA Follow-up', 'Clock'),
        sub('Offboarding', 'UserMinus'),
        sub('Account Decommissioning', 'UserX'),
        sub('Hardware Return / Collection', 'PackageMinus'),
        sub('Planned Maintenance / Notifications', 'CalendarClock'),
        sub('IT Administration', 'ClipboardList'),
        sub('Process Governance / Workflow Standardization', 'ListChecks'),
        sub('Projects / Office Moves', 'Building2'),
      ], 'FreshService showed high Onboarding and Offboarding volume even when not all tickets went through AI analysis.'),
      category('Telecom & Mobile Services', 'Smartphone', '#16a34a', 'Phones, carriers, roaming, phone-number provisioning, mobile fleet coordination, and MDM/iPad support.', [
        sub('Mobile Roaming Plan', 'Plane'),
        sub('Mobile Number Porting / Telephony', 'PhoneForwarded'),
        sub('Teams Phone Number Provisioning', 'PhoneCall'),
        sub('Carrier / Telus Coordination', 'RadioTower'),
        sub('Phone Asset Management', 'Smartphone'),
        sub('iPad / MDM Provisioning', 'Tablet'),
        sub('Device Tracking / Find My', 'MapPinned'),
      ], 'AI suggestions included phone number provisioning, Telus coordination, number porting, iPad/MDM, and device tracking.'),
      category('Noise, Non-Actionable & Misdirected', 'ArchiveX', '#64748b', 'Operational handling bucket for non-actionable or misdirected items, not a skills taxonomy for assignment routing.', [
        sub('Vendor Marketing / Promotional Email', 'Megaphone'),
        sub('FreshService Digest / Trending', 'Newspaper'),
        sub('Non-actionable Notifications', 'BellOff'),
        sub('Simulated Phishing / Training', 'GraduationCap'),
        sub('Misdirected Finance / Administrative Requests', 'CircleDollarSign'),
        sub('Non-IT Request / Route Elsewhere', 'RouteOff'),
      ], 'The pipeline dismissed 44 noise tickets in the window; blank and Other categories were high-volume.'),
    ],
    parkingLot: [
      { id: makeId('park', 'SharePoint and OneDrive boundary'), text: 'Decide whether OneDrive/SharePoint sync lives under Collaboration or Software.', createdAt: now },
      { id: makeId('park', 'Mobile Devices boundary'), text: 'Decide whether Mobile Devices lives under Endpoint or Telecom.', createdAt: now },
      { id: makeId('park', 'Finance requests boundary'), text: 'Decide whether Finance & Administrative Requests is a real IT taxonomy item or a misdirected/non-IT route.', createdAt: now },
    ],
    deletedItems: [],
    mergeSuggestions: [],
  };
}

function assertItWorkspace(workspaceId) {
  if (Number(workspaceId) !== IT_WORKSPACE_ID) {
    throw new AuthorizationError('The summit taxonomy workshop is currently available only in the IT workspace');
  }
}

function room(sessionId) {
  const key = String(sessionId);
  if (!clients.has(key)) clients.set(key, new Set());
  return clients.get(key);
}

function broadcast(sessionId, event, payload = {}) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of room(sessionId)) {
    try {
      res.write(data);
    } catch {
      room(sessionId).delete(res);
    }
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
  const [participants, grouped, mergeSuggestions, categorySuggestions] = await Promise.all([
    prisma.summitWorkshopParticipant.count({ where: { sessionId } }),
    prisma.summitWorkshopVote.groupBy({
      by: ['itemId', 'itemType', 'itemLabel', 'voteType'],
      where: { sessionId, voteType: { notIn: ['merge_suggestion', 'new_category_suggestion'] } },
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
    participantCount: participants,
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

async function serialize(session) {
  const [snapshots, votes] = await Promise.all([
    prisma.summitWorkshopSnapshot.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, version: true, label: true, snapshotType: true, createdBy: true, createdAt: true },
    }),
    getVoteSummary(session.id),
  ]);

  return {
    session,
    snapshots,
    votes,
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
          label: 'Initial summit taxonomy seed',
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
    throw new ValidationError('A valid taxonomy state with categories is required');
  }

  const existing = await findActiveSession(workspaceId) || await createSession(workspaceId, userEmail);
  const nextVersion = existing.activeVersion + 1;
  const nextState = { ...state, lastEditedAt: new Date().toISOString() };
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
  const voteExpiresAt = new Date(Date.now() + Math.max(15, Number(durationMinutes) || DEFAULT_DURATION_MINUTES) * 60 * 1000);
  if (regenerate && existing.voteToken) {
    closePublicStreams(existing.id, 'expired', {
      message: 'The facilitator regenerated the voting link. Please use the new link.',
    });
    await prisma.$transaction([
      prisma.summitWorkshopVote.deleteMany({ where: { sessionId: existing.id } }),
      prisma.summitWorkshopParticipant.deleteMany({ where: { sessionId: existing.id } }),
    ]);
  }
  const session = await prisma.summitWorkshopSession.update({
    where: { id: existing.id },
    data: { voteToken: token, voteEnabled: true, voteExpiresAt },
  });
  broadcast(session.id, 'state', publicSession(session));
  return serialize(session);
}

export async function getSessionByVoteToken(token) {
  const session = await prisma.summitWorkshopSession.findUnique({ where: { voteToken: token } });
  if (!session) throw new NotFoundError('Voting session not found');
  if (!session.voteEnabled || !session.voteExpiresAt || new Date(session.voteExpiresAt).getTime() <= Date.now()) {
    throw new AuthorizationError('This voting link has expired');
  }
  return session;
}

export async function getPublicWorkshop(token) {
  const session = await getSessionByVoteToken(token);
  return {
    session: publicSession(session),
    votes: await getVoteSummary(session.id),
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

export async function submitVote(token, body) {
  const session = await getSessionByVoteToken(token);
  const participantKey = String(body.participantKey || '');
  const participant = await prisma.summitWorkshopParticipant.findUnique({ where: { participantKey } });
  if (!participant || participant.sessionId !== session.id) throw new AuthorizationError('Join the workshop before voting');

  const voteType = String(body.voteType || 'support').slice(0, 40);
  const itemLabel = String(body.itemLabel || 'Workshop item').slice(0, 255);
  const itemType = String(body.itemType || 'category').slice(0, 30);
  const itemId = ['merge_suggestion', 'new_category_suggestion'].includes(voteType)
    ? `${voteType.replace('_suggestion', '')}_${participant.id}_${Date.now()}`
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
  return { votes };
}

export async function streamPublicWorkshop(token, res) {
  const session = await getSessionByVoteToken(token);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  room(session.id).add(res);
  res.write(`event: state\ndata: ${JSON.stringify(publicSession(session))}\n\n`);
  res.write(`event: votes\ndata: ${JSON.stringify(await getVoteSummary(session.id))}\n\n`);
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);
  res.on('close', () => {
    clearInterval(keepAlive);
    room(session.id).delete(res);
  });
}

export default {
  getOrCreateWorkshop,
  saveWorkshopState,
  restoreSnapshot,
  configureVoting,
  getPublicWorkshop,
  joinPublicWorkshop,
  submitVote,
  streamPublicWorkshop,
};
