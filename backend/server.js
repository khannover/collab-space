import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import FileStoreFactory from 'session-file-store';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'change-me-in-production';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/discord/callback`;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true';
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID ?? '';
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY ?? '';

const dataRoot = process.env.DATA_ROOT ?? path.resolve(__dirname, '..', 'backend-data');
const filesRoot = process.env.FILES_ROOT ?? path.join(dataRoot, 'files');
const databaseRoot = process.env.DATABASE_ROOT ?? path.join(dataRoot, 'database');
const sessionsRoot = process.env.SESSIONS_ROOT ?? path.join(dataRoot, 'sessions');
const dbPath = path.join(databaseRoot, 'collab-space.db');
const legacyStatePath = path.join(databaseRoot, 'app-state.json');

fs.mkdirSync(filesRoot, { recursive: true });
fs.mkdirSync(databaseRoot, { recursive: true });
fs.mkdirSync(sessionsRoot, { recursive: true });

const initialState = {
  projects: [
    {
      id: 'project-1',
      name: 'Only of Myself',
      genre: 'High-Energy Techno/EBM',
      status: 'In Progress',
      createdAt: '2026-04-24T10:00:00.000Z',
    },
    {
      id: 'project-2',
      name: 'Neon Horizon',
      genre: 'Synthwave',
      status: 'Mixing',
      createdAt: '2026-04-22T15:30:00.000Z',
    },
  ],
  projectData: {
    'project-1': {
      files: [],
      lyrics: `[Verse 1]\nstaring at the black mirror in the dead of night\ncounting up the metrics to validate the light\nyou constructed a persona built on hollow code\nwalking down a digital, a very lonely road\n\n[Pre-Chorus]\nso tell me who you are when the servers go down\nthe king of a kingdom without any crown\n\n[Chorus]\nonly of myself, that's all i ever see\ntrapped inside a loop of fake reality\n[scream] feed the machine!\nonly of myself, there is no you and me`,
      prompts: [
        {
          id: 'prompt-1',
          ver: 'Iteration #4',
          date: 'Apr 24, 2026',
          text: 'high-energy Techno, EBM, heavy synth bass, aggressive female vocals, industrial beats, [NO SLOP]',
        },
      ],
      notes: [
        {
          id: 'note-1',
          author: 'System',
          text: 'Welcome to the shared room. Notes, presence, and lyrics now sync through SQLite and sockets.',
          createdAt: '2026-04-24T11:00:00.000Z',
        },
      ],
    },
    'project-2': {
      files: [],
      lyrics: `[Verse 1]\ncruising down the grid, magenta skies above\ntrading in our heartbeats for a synthetic love\n\n[Chorus]\nneon horizon, bleeding into the night\nchasing the future, bathed in ultraviolet light`,
      prompts: [],
      notes: [],
    },
  },
};

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  },
});

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    genre TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lyrics TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    ver TEXT NOT NULL,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS allowed_users (
    discord_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    discord_username TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_assignments (
    project_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (project_id, discord_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

const insertProjectStatement = db.prepare(`
  INSERT INTO projects (id, name, genre, status, created_at, lyrics)
  VALUES (@id, @name, @genre, @status, @created_at, @lyrics)
`);
const insertFileStatement = db.prepare(`
  INSERT INTO files (id, project_id, name, stored_name, file_path, url, type, mime_type, size, uploaded_at, uploaded_by)
  VALUES (@id, @project_id, @name, @stored_name, @file_path, @url, @type, @mime_type, @size, @uploaded_at, @uploaded_by)
`);
const insertNoteStatement = db.prepare(`
  INSERT INTO notes (id, project_id, author, text, created_at)
  VALUES (@id, @project_id, @author, @text, @created_at)
`);
const insertPromptStatement = db.prepare(`
  INSERT INTO prompts (id, project_id, ver, date, text, created_at)
  VALUES (@id, @project_id, @ver, @date, @text, @created_at)
`);

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDateLabel(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function migrateLegacyStateIfNeeded() {
  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  if (existingCount > 0) {
    return;
  }

  let sourceState = initialState;
  if (fs.existsSync(legacyStatePath)) {
    try {
      sourceState = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
    } catch {
      sourceState = initialState;
    }
  }

  const importState = db.transaction((state) => {
    for (const project of state.projects ?? []) {
      const projectData = state.projectData?.[project.id] ?? {
        files: [],
        lyrics: '',
        prompts: [],
        notes: [],
      };

      insertProjectStatement.run({
        id: project.id,
        name: project.name,
        genre: project.genre ?? 'Unsorted',
        status: project.status ?? 'Planning',
        created_at: project.createdAt ?? new Date().toISOString(),
        lyrics: projectData.lyrics ?? '',
      });

      for (const file of projectData.files ?? []) {
        insertFileStatement.run({
          id: file.id ?? createId('file'),
          project_id: project.id,
          name: file.name,
          stored_name: file.storedName ?? file.name,
          file_path: file.path ?? path.join(filesRoot, project.id, file.storedName ?? file.name),
          url: file.url ?? `/api/projects/${project.id}/files/${file.storedName ?? file.name}`,
          type: file.type ?? 'other',
          mime_type: file.mimeType ?? 'application/octet-stream',
          size: Number(file.size) || 0,
          uploaded_at: file.uploadedAt ?? new Date().toISOString(),
          uploaded_by: file.uploadedBy ?? 'Unknown',
        });
      }

      for (const note of projectData.notes ?? []) {
        insertNoteStatement.run({
          id: note.id ?? createId('note'),
          project_id: project.id,
          author: note.author ?? 'Unknown',
          text: note.text ?? '',
          created_at: note.createdAt ?? new Date().toISOString(),
        });
      }

      for (const prompt of projectData.prompts ?? []) {
        insertPromptStatement.run({
          id: prompt.id ?? createId('prompt'),
          project_id: project.id,
          ver: prompt.ver ?? 'Iteration #1',
          date: prompt.date ?? formatDateLabel(new Date().toISOString()),
          text: prompt.text ?? '',
          created_at: prompt.createdAt ?? new Date().toISOString(),
        });
      }
    }
  });

  importState(sourceState);
}

migrateLegacyStateIfNeeded();

const FileStore = FileStoreFactory(session);
const sessionMiddleware = session({
  store: new FileStore({
    path: sessionsRoot,
    retries: 1,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware);

function getProject(projectId) {
  return db.prepare(`
    SELECT
      id,
      name,
      genre,
      status,
      created_at AS createdAt
    FROM projects
    WHERE id = ?
  `).get(projectId) ?? null;
}

function getProjectData(projectId) {
  const project = db.prepare('SELECT lyrics FROM projects WHERE id = ?').get(projectId);

  return {
    lyrics: project?.lyrics ?? '',
    files: db.prepare(`
      SELECT
        id,
        name,
        stored_name AS storedName,
        url,
        type,
        mime_type AS mimeType,
        size,
        uploaded_at AS uploadedAt,
        uploaded_by AS uploadedBy
      FROM files
      WHERE project_id = ?
      ORDER BY datetime(uploaded_at) DESC, rowid DESC
    `).all(projectId),
    notes: db.prepare(`
      SELECT
        id,
        author,
        text,
        created_at AS createdAt
      FROM notes
      WHERE project_id = ?
      ORDER BY datetime(created_at) ASC, rowid ASC
    `).all(projectId),
    prompts: db.prepare(`
      SELECT
        id,
        ver,
        date,
        text,
        created_at AS createdAt
      FROM prompts
      WHERE project_id = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
    `).all(projectId),
  };
}

function getState(userId) {
  const isAdmin = ADMIN_DISCORD_ID && userId === ADMIN_DISCORD_ID;

  const projects = (isAdmin || !ADMIN_DISCORD_ID || !userId)
    ? db.prepare(`
        SELECT id, name, genre, status, created_at AS createdAt
        FROM projects
        ORDER BY datetime(created_at) DESC, rowid DESC
      `).all()
    : db.prepare(`
        SELECT p.id, p.name, p.genre, p.status, p.created_at AS createdAt
        FROM projects p
        INNER JOIN project_assignments pa ON pa.project_id = p.id AND pa.discord_id = ?
        ORDER BY datetime(p.created_at) DESC, p.rowid DESC
      `).all(userId);

  const projectData = Object.fromEntries(projects.map((project) => [project.id, getProjectData(project.id)]));
  return { projects, projectData };
}

function getAuthConfig() {
  return {
    discordEnabled: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
    authRequired: AUTH_REQUIRED,
    adminConfigured: Boolean(ADMIN_DISCORD_ID),
  };
}

function getUserFromSession(req) {
  return req.session.user ?? null;
}

function isUserAllowed(userId) {
  if (!ADMIN_DISCORD_ID) {
    return true;
  }

  if (userId === ADMIN_DISCORD_ID) {
    return true;
  }

  return Boolean(db.prepare('SELECT 1 FROM allowed_users WHERE discord_id = ?').get(userId));
}

function requireUser(req, res, next) {
  const { discordEnabled, authRequired } = getAuthConfig();

  if (!authRequired && !discordEnabled) {
    next();
    return;
  }

  if (!req.session.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  if (!isUserAllowed(req.session.user.id)) {
    res.status(403).json({ error: 'Access denied.' });
    return;
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_DISCORD_ID) {
    res.status(503).json({ error: 'Admin not configured.' });
    return;
  }

  if (!req.session.user || req.session.user.id !== ADMIN_DISCORD_ID) {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }

  next();
}

function getActorName(req) {
  return req.session.user?.globalName ?? req.session.user?.username ?? `Guest-${req.sessionID.slice(0, 4)}`;
}

function getSocketActor(socket) {
  const user = socket.request.session?.user;
  return {
    id: user?.id ?? `guest:${socket.request.sessionID ?? socket.id}`,
    name: user?.globalName ?? user?.username ?? `Guest-${(socket.request.sessionID ?? socket.id).slice(0, 4)}`,
    avatar: user?.avatar ?? null,
  };
}

const presenceByProject = new Map();
const editorsByProject = new Map();

function getProjectMap(store, projectId) {
  if (!store.has(projectId)) {
    store.set(projectId, new Map());
  }

  return store.get(projectId);
}

function removeSocketFromProject(store, projectId, socketId) {
  const projectMap = store.get(projectId);
  if (!projectMap) {
    return;
  }

  projectMap.delete(socketId);
  if (projectMap.size === 0) {
    store.delete(projectId);
  }
}

function emitPresence(projectId) {
  io.to(`project:${projectId}`).emit('presence:updated', {
    projectId,
    members: Array.from((presenceByProject.get(projectId) ?? new Map()).values()),
    editors: Array.from((editorsByProject.get(projectId) ?? new Map()).values()),
  });
}

function joinProjectRoom(socket, projectId) {
  const actor = getSocketActor(socket);
  const previousProjectId = socket.data.projectId;

  if (previousProjectId && previousProjectId !== projectId) {
    socket.leave(`project:${previousProjectId}`);
    removeSocketFromProject(presenceByProject, previousProjectId, socket.id);
    removeSocketFromProject(editorsByProject, previousProjectId, socket.id);
    emitPresence(previousProjectId);
  }

  socket.data.projectId = projectId;
  socket.join(`project:${projectId}`);
  getProjectMap(presenceByProject, projectId).set(socket.id, actor);
  emitPresence(projectId);
}

function setEditorState(socket, projectId, isEditing) {
  const actor = getSocketActor(socket);
  const projectEditors = getProjectMap(editorsByProject, projectId);

  if (isEditing) {
    projectEditors.set(socket.id, actor);
  } else {
    removeSocketFromProject(editorsByProject, projectId, socket.id);
  }

  emitPresence(projectId);
}

function broadcastProject(projectId) {
  const project = getProject(projectId);
  const projectData = getProjectData(projectId);

  io.to(`project:${projectId}`).emit('project:updated', {
    project,
    projectData,
  });
}

function buildDiscordAuthUrl() {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
  });

  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeDiscordCode(code) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: DISCORD_REDIRECT_URI,
  });

  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!tokenResponse.ok) {
    throw new Error('Discord token exchange failed');
  }

  const tokenData = await tokenResponse.json();
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `${tokenData.token_type} ${tokenData.access_token}`,
    },
  });

  if (!userResponse.ok) {
    throw new Error('Discord user lookup failed');
  }

  const discordUser = await userResponse.json();
  return {
    id: discordUser.id,
    username: discordUser.username,
    globalName: discordUser.global_name,
    avatar: discordUser.avatar,
  };
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectDir = path.join(filesRoot, req.params.projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    cb(null, projectDir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  },
});

const upload = multer({ storage });

io.engine.use((req, res, next) => {
  sessionMiddleware(req, res, next);
});

io.on('connection', (socket) => {
  socket.on('project:join', ({ projectId }) => {
    if (!projectId || !getProject(projectId)) {
      return;
    }

    const userId = socket.request.session?.user?.id;
    if (!isUserAllowed(userId ?? '')) {
      return;
    }

    const isAdmin = ADMIN_DISCORD_ID && userId === ADMIN_DISCORD_ID;
    if (ADMIN_DISCORD_ID && !isAdmin && userId) {
      const assigned = db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND discord_id = ?').get(projectId, userId);
      if (!assigned) {
        return;
      }
    }

    joinProjectRoom(socket, projectId);
  });

  socket.on('lyrics:update', ({ projectId, lyrics }) => {
    if (!projectId || !getProject(projectId)) {
      return;
    }

    db.prepare('UPDATE projects SET lyrics = ? WHERE id = ?').run(String(lyrics ?? ''), projectId);
    io.to(`project:${projectId}`).emit('lyrics:updated', { projectId, lyrics: String(lyrics ?? '') });
  });

  socket.on('lyrics:editing', ({ projectId, isEditing }) => {
    if (!projectId || !getProject(projectId)) {
      return;
    }

    setEditorState(socket, projectId, Boolean(isEditing));
  });

  socket.on('disconnect', () => {
    const projectId = socket.data.projectId;
    if (!projectId) {
      return;
    }

    removeSocketFromProject(presenceByProject, projectId, socket.id);
    removeSocketFromProject(editorsByProject, projectId, socket.id);
    emitPresence(projectId);
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json(getAuthConfig());
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromSession(req);
  res.json({
    user,
    isAdmin: Boolean(ADMIN_DISCORD_ID && user?.id === ADMIN_DISCORD_ID),
    ...getAuthConfig(),
  });
});

app.get('/api/auth/discord', (_req, res) => {
  const { discordEnabled } = getAuthConfig();

  if (!discordEnabled) {
    res.status(503).json({ error: 'Discord auth is not configured.' });
    return;
  }

  res.redirect(buildDiscordAuthUrl());
});

app.get('/api/auth/discord/callback', async (req, res) => {
  try {
    const { discordEnabled } = getAuthConfig();
    if (!discordEnabled || typeof req.query.code !== 'string') {
      res.redirect(`${FRONTEND_URL}?login=failed`);
      return;
    }

    const user = await exchangeDiscordCode(req.query.code);

    if (!isUserAllowed(user.id)) {
      res.redirect(`${FRONTEND_URL}?login=denied`);
      return;
    }

    // Keep display info fresh when an allowed user logs in
    if (ADMIN_DISCORD_ID && user.id !== ADMIN_DISCORD_ID) {
      db.prepare(
        'UPDATE allowed_users SET display_name = ?, discord_username = ? WHERE discord_id = ?',
      ).run(user.globalName ?? user.username ?? '', user.username ?? '', user.id);
    }

    req.session.user = user;
    req.session.save(() => {
      res.redirect(FRONTEND_URL);
    });
  } catch {
    res.redirect(`${FRONTEND_URL}?login=failed`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/projects', requireUser, (req, res) => {
  res.json(getState(req.session.user?.id ?? null));
});

app.post('/api/projects', requireUser, (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const genre = String(req.body.genre ?? '').trim();
  const status = String(req.body.status ?? 'Planning').trim() || 'Planning';

  if (!name) {
    res.status(400).json({ error: 'Project name is required.' });
    return;
  }

  const project = {
    id: createId('project'),
    name,
    genre: genre || 'Unsorted',
    status,
    createdAt: new Date().toISOString(),
  };

  insertProjectStatement.run({
    id: project.id,
    name: project.name,
    genre: project.genre,
    status: project.status,
    created_at: project.createdAt,
    lyrics: '',
  });

  res.status(201).json({ project });
  broadcastProject(project.id);
});

app.delete('/api/projects/:projectId', requireUser, (req, res) => {
  const project = getProject(req.params.projectId);

  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const projectCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  if (projectCount === 1) {
    res.status(400).json({ error: 'At least one project must remain.' });
    return;
  }

  const files = db.prepare('SELECT file_path AS filePath FROM files WHERE project_id = ?').all(req.params.projectId);
  const deleteProject = db.transaction(() => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.projectId);
  });

  deleteProject();
  for (const file of files) {
    fs.rmSync(file.filePath, { force: true });
  }
  fs.rmSync(path.join(filesRoot, req.params.projectId), { recursive: true, force: true });

  presenceByProject.delete(req.params.projectId);
  editorsByProject.delete(req.params.projectId);
  io.emit('project:deleted', { projectId: req.params.projectId });
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/files', requireUser, upload.array('files'), (req, res) => {
  const project = getProject(req.params.projectId);

  if (!project) {
    for (const file of req.files ?? []) {
      fs.rmSync(file.path, { force: true });
    }
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const uploadedFiles = (req.files ?? []).map((file) => ({
    id: createId('file'),
    project_id: req.params.projectId,
    name: file.originalname,
    stored_name: file.filename,
    file_path: file.path,
    url: `/api/projects/${req.params.projectId}/files/${file.filename}`,
    type: file.mimetype.startsWith('audio/') ? 'audio' : file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('text/') ? 'text' : 'other',
    mime_type: file.mimetype,
    size: file.size,
    uploaded_at: new Date().toISOString(),
    uploaded_by: getActorName(req),
  }));

  const insertFiles = db.transaction((files) => {
    for (const file of files) {
      insertFileStatement.run(file);
    }
  });
  insertFiles(uploadedFiles);

  const responseFiles = getProjectData(req.params.projectId).files.filter((file) => uploadedFiles.some((uploaded) => uploaded.id === file.id));
  res.status(201).json({ files: responseFiles });
  broadcastProject(req.params.projectId);
});

app.get('/api/projects/:projectId/files/:storedName', requireUser, (req, res) => {
  const file = db.prepare(`
    SELECT file_path AS filePath
    FROM files
    WHERE project_id = ? AND stored_name = ?
  `).get(req.params.projectId, req.params.storedName);

  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  res.sendFile(path.resolve(file.filePath));
});

app.delete('/api/projects/:projectId/files/:fileId', requireUser, (req, res) => {
  const file = db.prepare(`
    SELECT file_path AS filePath
    FROM files
    WHERE project_id = ? AND id = ?
  `).get(req.params.projectId, req.params.fileId);

  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  db.prepare('DELETE FROM files WHERE id = ?').run(req.params.fileId);
  fs.rmSync(file.filePath, { force: true });
  broadcastProject(req.params.projectId);
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/notes', requireUser, (req, res) => {
  if (!getProject(req.params.projectId)) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const text = String(req.body.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'Note text is required.' });
    return;
  }

  const note = {
    id: createId('note'),
    project_id: req.params.projectId,
    author: getActorName(req),
    text,
    created_at: new Date().toISOString(),
  };

  insertNoteStatement.run(note);
  res.status(201).json({ note: { id: note.id, author: note.author, text: note.text, createdAt: note.created_at } });
  broadcastProject(req.params.projectId);
});

app.post('/api/projects/:projectId/prompts', requireUser, (req, res) => {
  if (!getProject(req.params.projectId)) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const text = String(req.body.text ?? '').trim();
  const version = String(req.body.ver ?? '').trim();

  if (!text) {
    res.status(400).json({ error: 'Prompt text is required.' });
    return;
  }

  const createdAt = new Date().toISOString();
  const currentPromptCount = db.prepare('SELECT COUNT(*) AS count FROM prompts WHERE project_id = ?').get(req.params.projectId).count;
  const prompt = {
    id: createId('prompt'),
    project_id: req.params.projectId,
    ver: version || `Iteration #${currentPromptCount + 1}`,
    date: formatDateLabel(createdAt),
    text,
    created_at: createdAt,
  };

  insertPromptStatement.run(prompt);
  res.status(201).json({ prompt: { id: prompt.id, ver: prompt.ver, date: prompt.date, text: prompt.text, createdAt } });
  broadcastProject(req.params.projectId);
});

app.put('/api/projects/:projectId/lyrics', requireUser, (req, res) => {
  if (!getProject(req.params.projectId)) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const lyrics = String(req.body.lyrics ?? '');
  db.prepare('UPDATE projects SET lyrics = ? WHERE id = ?').run(lyrics, req.params.projectId);
  broadcastProject(req.params.projectId);
  res.json({ ok: true });
});

// ── Admin: user management ────────────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT discord_id AS discordId, display_name AS displayName, discord_username AS discordUsername, added_at AS addedAt
    FROM allowed_users
    ORDER BY datetime(added_at) ASC
  `).all();

  const result = users.map((user) => ({
    ...user,
    projects: db.prepare('SELECT project_id AS projectId FROM project_assignments WHERE discord_id = ?')
      .all(user.discordId)
      .map((row) => row.projectId),
  }));

  res.json({ users: result });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const discordId = String(req.body.discordId ?? '').trim();
  const displayName = String(req.body.displayName ?? '').trim();

  if (!discordId) {
    res.status(400).json({ error: 'Discord ID is required.' });
    return;
  }

  if (ADMIN_DISCORD_ID && discordId === ADMIN_DISCORD_ID) {
    res.status(400).json({ error: 'Admin cannot be added as a regular user.' });
    return;
  }

  db.prepare(`
    INSERT INTO allowed_users (discord_id, display_name, discord_username, added_at)
    VALUES (?, ?, '', ?)
    ON CONFLICT(discord_id) DO UPDATE SET display_name = excluded.display_name
  `).run(discordId, displayName, new Date().toISOString());

  const user = db.prepare(`
    SELECT discord_id AS discordId, display_name AS displayName, discord_username AS discordUsername, added_at AS addedAt
    FROM allowed_users WHERE discord_id = ?
  `).get(discordId);

  res.status(201).json({
    user: {
      ...user,
      projects: db.prepare('SELECT project_id AS projectId FROM project_assignments WHERE discord_id = ?')
        .all(discordId)
        .map((row) => row.projectId),
    },
  });
});

app.delete('/api/admin/users/:discordId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM allowed_users WHERE discord_id = ?').run(req.params.discordId);
  res.json({ ok: true });
});

app.post('/api/admin/users/:discordId/projects/:projectId', requireAdmin, (req, res) => {
  if (!getProject(req.params.projectId)) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  if (!db.prepare('SELECT 1 FROM allowed_users WHERE discord_id = ?').get(req.params.discordId)) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  db.prepare(`
    INSERT INTO project_assignments (project_id, discord_id, assigned_at)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(req.params.projectId, req.params.discordId, new Date().toISOString());

  res.status(201).json({ ok: true });
});

app.delete('/api/admin/users/:discordId/projects/:projectId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND discord_id = ?')
    .run(req.params.projectId, req.params.discordId);
  res.json({ ok: true });
});

// ── Cover image generation ────────────────────────────────────────────────────

app.post('/api/projects/:projectId/cover-image', requireUser, async (req, res) => {
  if (!getProject(req.params.projectId)) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const prompt = String(req.body.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'Prompt is required.' });
    return;
  }

  if (!POLLINATIONS_API_KEY) {
    res.status(503).json({ error: 'Image generation is not configured.' });
    return;
  }

  const params = new URLSearchParams({
    width: '1024',
    height: '1024',
    model: 'flux',
    nologo: 'true',
    token: POLLINATIONS_API_KEY,
  });

  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;

  try {
    const imageResponse = await fetch(pollinationsUrl);
    if (!imageResponse.ok) {
      res.status(502).json({ error: 'Image generation failed.' });
      return;
    }

    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = imageResponse.headers.get('content-type') ?? 'image/jpeg';

    res.json({ imageUrl: `data:${contentType};base64,${base64}` });
  } catch {
    res.status(502).json({ error: 'Image generation failed.' });
  }
});

server.listen(PORT, () => {
  console.log(`collab-space backend listening on ${PORT}`);
});
