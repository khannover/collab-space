import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  File,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  LogIn,
  LogOut,
  MessageSquare,
  Play,
  Plus,
  Share2,
  Sparkles,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { io } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_BASE ?? `${window.location.protocol}//${window.location.hostname}:3001`;
const EMPTY_STATE = { projects: [], projectData: {} };

function apiUrl(pathname) {
  return `${API_BASE}${pathname}`;
}

function createEmptyProjectData() {
  return {
    files: [],
    lyrics: '',
    prompts: [],
    notes: [],
  };
}

function formatBytes(bytes) {
  if (!bytes) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

function formatDateLabel(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function getInitialProjectId(projects) {
  const params = new URLSearchParams(window.location.search);
  const requestedProjectId = params.get('project');
  const projectExists = projects.some((project) => project.id === requestedProjectId);

  return projectExists ? requestedProjectId : projects[0]?.id ?? null;
}

async function apiRequest(pathname, options = {}) {
  const response = await fetch(apiUrl(pathname), {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const maybeJson = await response.json().catch(() => null);
    throw new Error(maybeJson?.error ?? 'Request failed.');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  return response.json();
}

export default function App() {
  const [appState, setAppState] = useState(EMPTY_STATE);
  const [authState, setAuthState] = useState({ user: null, discordEnabled: false, authRequired: false });
  const [presenceState, setPresenceState] = useState({ members: [], editors: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [activeProject, setActiveProject] = useState(null);
  const [activeTab, setActiveTab] = useState('files');
  const [playingFileId, setPlayingFileId] = useState(null);
  const [draftLyrics, setDraftLyrics] = useState('');
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', genre: '', status: 'Planning' });
  const [newNote, setNewNote] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newPromptVersion, setNewPromptVersion] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isSavingLyrics, setIsSavingLyrics] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);
  const lyricsTimeoutRef = useRef(null);
  const activeProjectRef = useRef(null);

  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const auth = await apiRequest('/api/auth/me');

        if (cancelled) {
          return;
        }

        setAuthState(auth);

        if ((auth.discordEnabled || auth.authRequired) && !auth.user) {
          setIsLoading(false);
          return;
        }

        const state = await apiRequest('/api/projects');

        if (cancelled) {
          return;
        }

        setAppState(state);
        setActiveProject(getInitialProjectId(state.projects));
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(error.message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const socket = io(API_BASE, { withCredentials: true });
    socketRef.current = socket;

    socket.on('project:updated', ({ project, projectData }) => {
      if (!project) {
        return;
      }

      setAppState((previousState) => {
        const exists = previousState.projects.some((entry) => entry.id === project.id);
        const nextProjects = exists
          ? previousState.projects.map((entry) => entry.id === project.id ? project : entry)
          : [project, ...previousState.projects];

        return {
          projects: nextProjects,
          projectData: {
            ...previousState.projectData,
            ...(projectData ? { [project.id]: projectData } : {}),
          },
        };
      });
    });

    socket.on('project:deleted', ({ projectId }) => {
      setAppState((previousState) => {
        const nextProjectData = { ...previousState.projectData };
        delete nextProjectData[projectId];

        return {
          projects: previousState.projects.filter((project) => project.id !== projectId),
          projectData: nextProjectData,
        };
      });
      setActiveProject((previousActiveProject) => previousActiveProject === projectId ? null : previousActiveProject);
    });

    socket.on('lyrics:updated', ({ projectId, lyrics }) => {
      setAppState((previousState) => ({
        ...previousState,
        projectData: {
          ...previousState.projectData,
          [projectId]: {
            ...(previousState.projectData[projectId] ?? createEmptyProjectData()),
            lyrics,
          },
        },
      }));

      if (projectId === activeProjectRef.current) {
        setDraftLyrics(lyrics);
      }
    });

    socket.on('presence:updated', ({ projectId, members, editors }) => {
      if (projectId !== activeProjectRef.current) {
        return;
      }

      setPresenceState({
        members: members ?? [],
        editors: editors ?? [],
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!activeProject || appState.projects.some((project) => project.id === activeProject)) {
      return;
    }

    setActiveProject(appState.projects[0]?.id ?? null);
  }, [activeProject, appState.projects]);

  useEffect(() => {
    const project = appState.projectData[activeProject] ?? createEmptyProjectData();
    setDraftLyrics(project.lyrics);
    setPlayingFileId(null);
    setPresenceState({ members: [], editors: [] });

    if (activeProject && socketRef.current) {
      socketRef.current.emit('project:join', { projectId: activeProject });
    }
  }, [activeProject, appState.projectData]);

  useEffect(() => {
    if (!activeProject) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('project', activeProject);
    window.history.replaceState({}, '', url);
  }, [activeProject]);

  useEffect(() => {
    if (!statusMessage) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setStatusMessage('');
    }, 2800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [statusMessage]);

  useEffect(() => () => {
    if (lyricsTimeoutRef.current) {
      window.clearTimeout(lyricsTimeoutRef.current);
    }
  }, []);

  const currentProjectInfo = appState.projects.find((project) => project.id === activeProject);
  const currentData = appState.projectData[activeProject] ?? createEmptyProjectData();
  const playingFile = currentData.files.find((file) => file.id === playingFileId) ?? null;
  const ownDisplayName = authState.user?.globalName ?? authState.user?.username ?? 'Guest';
  const activeEditors = presenceState.editors.map((editor) => editor.name);

  function renderIcon(type) {
    switch (type) {
      case 'audio':
        return <FileAudio className="text-orange-400" size={20} />;
      case 'video':
        return <FileVideo className="text-blue-400" size={20} />;
      case 'text':
        return <FileText className="text-stone-300" size={20} />;
      default:
        return <File className="text-neutral-400" size={20} />;
    }
  }

  function handleProjectSwitch(projectId) {
    setActiveProject(projectId);
    setActiveTab('files');
  }

  function handleLyricsFocus() {
    if (!activeProject) {
      return;
    }

    socketRef.current?.emit('lyrics:editing', { projectId: activeProject, isEditing: true });
  }

  function handleLyricsBlur() {
    if (!activeProject) {
      return;
    }

    socketRef.current?.emit('lyrics:editing', { projectId: activeProject, isEditing: false });
  }

  async function refreshProjects(preferredProjectId) {
    const state = await apiRequest('/api/projects');
    setAppState(state);
    setActiveProject(preferredProjectId ?? getInitialProjectId(state.projects));
  }

  async function handleDeleteProject(projectId) {
    const project = appState.projects.find((item) => item.id === projectId);

    if (!project) {
      return;
    }

    if (appState.projects.length === 1) {
      setStatusMessage('Create another project before removing the last one.');
      return;
    }

    const confirmed = window.confirm(`Remove project "${project.name}" and all of its stored files?`);

    if (!confirmed) {
      return;
    }

    try {
      await apiRequest(`/api/projects/${projectId}`, { method: 'DELETE' });
      const remainingProjects = appState.projects.filter((item) => item.id !== projectId);
      setActiveProject(activeProject === projectId ? remainingProjects[0]?.id ?? null : activeProject);
      setPlayingFileId(null);
      setStatusMessage('Project removed.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function handleCreateProject(event) {
    event.preventDefault();

    if (!newProject.name.trim()) {
      setStatusMessage('Project name is required.');
      return;
    }

    try {
      const response = await apiRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(newProject),
      });
      await refreshProjects(response.project.id);
      setNewProject({ name: '', genre: '', status: 'Planning' });
      setShowCreateProject(false);
      setActiveProject(response.project.id);
      setStatusMessage('Project created.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function handleFileUpload(event) {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0 || !activeProject) {
      return;
    }

    try {
      setIsUploadingFiles(true);
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      const response = await apiRequest(`/api/projects/${activeProject}/files`, {
        method: 'POST',
        body: formData,
      });
      setAppState((previousState) => ({
        ...previousState,
        projectData: {
          ...previousState.projectData,
          [activeProject]: {
            ...(previousState.projectData[activeProject] ?? createEmptyProjectData()),
            files: [...response.files, ...(previousState.projectData[activeProject]?.files ?? [])],
          },
        },
      }));
      setStatusMessage(`${response.files.length} file${response.files.length > 1 ? 's' : ''} uploaded.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setIsUploadingFiles(false);
      event.target.value = '';
    }
  }

  async function handleDeleteFile(fileId) {
    try {
      await apiRequest(`/api/projects/${activeProject}/files/${fileId}`, { method: 'DELETE' });
      setAppState((previousState) => ({
        ...previousState,
        projectData: {
          ...previousState.projectData,
          [activeProject]: {
            ...(previousState.projectData[activeProject] ?? createEmptyProjectData()),
            files: (previousState.projectData[activeProject]?.files ?? []).filter((file) => file.id !== fileId),
          },
        },
      }));

      if (playingFileId === fileId) {
        setPlayingFileId(null);
      }

      setStatusMessage('File removed.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  function handleDownloadFile(file) {
    const link = document.createElement('a');
    link.href = apiUrl(file.url);
    link.download = file.name;
    link.click();
  }

  async function handleShareProject() {
    if (!activeProject) {
      return;
    }

    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set('project', activeProject);

    try {
      await navigator.clipboard.writeText(shareUrl.toString());
      setStatusMessage('Project link copied.');
    } catch {
      setStatusMessage(shareUrl.toString());
    }
  }

  function handleLyricsChange(nextLyrics) {
    socketRef.current?.emit('lyrics:editing', { projectId: activeProject, isEditing: true });
    setDraftLyrics(nextLyrics);
    setAppState((previousState) => ({
      ...previousState,
      projectData: {
        ...previousState.projectData,
        [activeProject]: {
          ...(previousState.projectData[activeProject] ?? createEmptyProjectData()),
          lyrics: nextLyrics,
        },
      },
    }));

    if (lyricsTimeoutRef.current) {
      window.clearTimeout(lyricsTimeoutRef.current);
    }

    lyricsTimeoutRef.current = window.setTimeout(async () => {
      setIsSavingLyrics(true);
      socketRef.current?.emit('lyrics:update', { projectId: activeProject, lyrics: nextLyrics });

      try {
        await apiRequest(`/api/projects/${activeProject}/lyrics`, {
          method: 'PUT',
          body: JSON.stringify({ lyrics: nextLyrics }),
        });
      } catch (error) {
        setStatusMessage(error.message);
      } finally {
        setIsSavingLyrics(false);
      }
    }, 180);
  }

  async function handleAddNote(event) {
    event.preventDefault();

    if (!newNote.trim()) {
      return;
    }

    try {
      await apiRequest(`/api/projects/${activeProject}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: newNote }),
      });
      setNewNote('');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function handleAddPrompt(event) {
    event.preventDefault();

    if (!newPrompt.trim()) {
      return;
    }

    try {
      const response = await apiRequest(`/api/projects/${activeProject}/prompts`, {
        method: 'POST',
        body: JSON.stringify({ ver: newPromptVersion, text: newPrompt }),
      });
      setAppState((previousState) => ({
        ...previousState,
        projectData: {
          ...previousState.projectData,
          [activeProject]: {
            ...(previousState.projectData[activeProject] ?? createEmptyProjectData()),
            prompts: [response.prompt, ...(previousState.projectData[activeProject]?.prompts ?? [])],
          },
        },
      }));
      setNewPrompt('');
      setNewPromptVersion('');
      setStatusMessage('Prompt saved.');
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function copyPrompt(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage('Prompt copied.');
    } catch {
      setStatusMessage('Clipboard access was denied.');
    }
  }

  async function handleLogout() {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(249,115,22,0.15),_transparent_38%),linear-gradient(180deg,_#111315_0%,_#090909_100%)] text-neutral-100">
        <div className="rounded-3xl border border-white/10 bg-black/30 px-6 py-4 text-sm text-neutral-300">Loading workspace...</div>
      </div>
    );
  }

  if ((authState.discordEnabled || authState.authRequired) && !authState.user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(249,115,22,0.18),_transparent_38%),linear-gradient(180deg,_#111315_0%,_#090909_100%)] px-6 text-neutral-100">
        <div className="w-full max-w-lg rounded-[32px] border border-white/10 bg-black/35 p-8 shadow-2xl shadow-black/30">
          <div className="flex items-center gap-3 text-2xl font-semibold text-white">
            <Terminal size={24} className="text-orange-400" />
            CollabSpace
          </div>
          <p className="mt-4 text-sm leading-7 text-neutral-400">This workspace now stores project data on the server and syncs chat, lyrics, and uploads for everyone in the room.</p>
          <button onClick={() => { window.location.href = apiUrl('/api/auth/discord'); }} className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-500 px-4 py-3 text-sm font-medium text-black transition hover:bg-orange-400">
            <LogIn size={16} />
            Log In With Discord
          </button>
        </div>
      </div>
    );
  }

  if (!currentProjectInfo) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(249,115,22,0.15),_transparent_38%),linear-gradient(180deg,_#111315_0%,_#090909_100%)] text-neutral-100">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />

      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col lg:flex-row">
        <aside className="w-full border-b border-white/10 bg-black/30 backdrop-blur lg:w-72 lg:border-b-0 lg:border-r">
          <div className="border-b border-white/10 px-6 py-6">
            <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight text-white">
              <Terminal size={24} className="text-orange-400" />
              CollabSpace
            </h1>
            <p className="mt-2 text-sm text-neutral-400">Shared rooms, shared notes, shared lyrics, shared files.</p>
          </div>

          <div className="px-4 py-6">
            <button
              onClick={() => setShowCreateProject((value) => !value)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-500 px-4 py-3 text-sm font-medium text-black transition hover:bg-orange-400"
            >
              <FolderPlus size={16} />
              New Project
            </button>

            {showCreateProject && (
              <form onSubmit={handleCreateProject} className="mt-4 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                <input
                  value={newProject.name}
                  onChange={(event) => setNewProject((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Project name"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none transition focus:border-orange-400"
                />
                <input
                  value={newProject.genre}
                  onChange={(event) => setNewProject((current) => ({ ...current, genre: event.target.value }))}
                  placeholder="Genre or direction"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none transition focus:border-orange-400"
                />
                <select
                  value={newProject.status}
                  onChange={(event) => setNewProject((current) => ({ ...current, status: event.target.value }))}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none transition focus:border-orange-400"
                >
                  <option>Planning</option>
                  <option>In Progress</option>
                  <option>Mixing</option>
                  <option>Review</option>
                  <option>Done</option>
                </select>
                <div className="flex gap-2">
                  <button type="submit" className="flex-1 rounded-xl bg-white px-3 py-2 text-sm font-medium text-black transition hover:bg-orange-100">Create</button>
                  <button type="button" onClick={() => setShowCreateProject(false)} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-neutral-300 transition hover:bg-white/5">Cancel</button>
                </div>
              </form>
            )}
          </div>

          <div className="px-3 pb-6">
            <div className="mb-3 px-3 text-xs font-semibold uppercase tracking-[0.24em] text-neutral-500">Projects</div>
            <div className="space-y-2">
              {appState.projects.map((project) => (
                <div
                  key={project.id}
                  className={`rounded-2xl border px-4 py-3 transition ${
                    activeProject === project.id
                      ? 'border-orange-400/40 bg-orange-500/10 text-orange-200 shadow-[0_0_0_1px_rgba(249,115,22,0.18)]'
                      : 'border-transparent bg-white/5 text-neutral-200 hover:border-white/10 hover:bg-white/10'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <button onClick={() => handleProjectSwitch(project.id)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-start gap-3">
                        <Folder size={16} className={activeProject === project.id ? 'mt-0.5 text-orange-300' : 'mt-0.5 text-neutral-500'} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{project.name}</div>
                          <div className="mt-1 truncate text-xs text-neutral-500">{project.genre}</div>
                          <div className="mt-2 inline-flex rounded-full border border-white/10 px-2 py-1 text-[11px] uppercase tracking-[0.2em] text-neutral-400">{project.status}</div>
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => handleDeleteProject(project.id)}
                      className="rounded-xl border border-white/10 p-2 text-neutral-500 transition hover:bg-white/10 hover:text-white"
                      title={`Remove ${project.name}`}
                      aria-label={`Remove ${project.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-white/10 bg-black/20 px-6 py-5 backdrop-blur md:px-8">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-3xl font-semibold tracking-tight text-white">{currentProjectInfo.name}</h2>
                  <span className="rounded-full border border-orange-400/30 bg-orange-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-orange-200">{currentProjectInfo.status}</span>
                  <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-emerald-200">{presenceState.members.length} online</span>
                </div>
                <p className="mt-2 text-sm text-neutral-400">{currentProjectInfo.genre}</p>
                {presenceState.members.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {presenceState.members.map((member) => (
                      <span key={member.id} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300">
                        {member.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-neutral-200">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500/15 text-orange-200">
                    {(authState.user?.globalName ?? authState.user?.username ?? 'G').slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <div className="font-medium text-white">{authState.user?.globalName ?? authState.user?.username ?? 'Guest mode'}</div>
                    <div className="text-xs text-neutral-500">{authState.user ? 'Connected through Discord' : 'Discord auth not configured'}</div>
                  </div>
                </div>
                <button
                  onClick={handleShareProject}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white transition hover:bg-white/10"
                >
                  <Share2 size={16} />
                  Copy Link
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-orange-500 px-4 py-3 text-sm font-medium text-black transition hover:bg-orange-400"
                >
                  <UploadCloud size={16} />
                  {isUploadingFiles ? 'Uploading...' : 'Upload Files'}
                </button>
                {authState.user && (
                  <button onClick={handleLogout} className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white transition hover:bg-white/10">
                    <LogOut size={16} />
                    Log Out
                  </button>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-6 border-t border-white/10 pt-4 text-sm">
              {['files', 'lyrics', 'suno prompts'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`border-b-2 pb-3 capitalize transition ${
                    activeTab === tab ? 'border-orange-400 text-orange-300' : 'border-transparent text-neutral-500 hover:text-neutral-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </header>

          <div className="flex-1 px-6 py-6 md:px-8">
            {statusMessage && (
              <div className="mb-5 flex items-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                <CheckCircle2 size={16} />
                {statusMessage}
              </div>
            )}

            {activeTab === 'files' && (
              <div className="rounded-[28px] border border-white/10 bg-black/25 p-4 shadow-2xl shadow-black/20 md:p-6">
                <div className="mb-5 flex flex-col gap-3 border-b border-white/10 pb-5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-xl font-semibold text-white">Project Files</h3>
                    <p className="mt-1 text-sm text-neutral-400">Uploads now live on the server, so everyone in the project sees the same asset list.</p>
                  </div>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-2xl border border-dashed border-orange-400/40 px-4 py-3 text-sm text-orange-200 transition hover:bg-orange-500/10"
                  >
                    Add media or docs
                  </button>
                </div>

                {currentData.files.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 px-6 py-16 text-center text-neutral-400">
                    <HardDrive size={48} className="mx-auto mb-4 opacity-60" />
                    <p className="text-lg text-white">No files in this project yet.</p>
                    <p className="mt-2 text-sm text-neutral-500">Use the upload button to attach audio, video, lyrics drafts, or reference files.</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-3xl border border-white/10">
                    <table className="w-full border-collapse text-left text-sm">
                      <thead className="bg-white/5 text-neutral-400">
                        <tr>
                          <th className="px-5 py-4 font-medium">Name</th>
                          <th className="px-5 py-4 font-medium">Type</th>
                          <th className="px-5 py-4 font-medium">Size</th>
                          <th className="px-5 py-4 font-medium">Added</th>
                          <th className="px-5 py-4 text-right font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentData.files.map((file) => (
                          <tr key={file.id} className="border-t border-white/10 bg-black/10 transition hover:bg-white/5">
                            <td className="px-5 py-4">
                              <div className="flex items-center gap-3">
                                {renderIcon(file.type)}
                                <div>
                                  <div className="font-medium text-white">{file.name}</div>
                                  <div className="text-xs text-neutral-500">{file.mimeType || 'application/octet-stream'} · {file.uploadedBy ?? 'Unknown'}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-5 py-4 text-neutral-300">{file.type}</td>
                            <td className="px-5 py-4 text-neutral-300">{formatBytes(file.size)}</td>
                            <td className="px-5 py-4 text-neutral-500">{formatDateLabel(file.uploadedAt)}</td>
                            <td className="px-5 py-4">
                              <div className="flex justify-end gap-2">
                                <button onClick={() => handleDownloadFile(file)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-neutral-200 transition hover:bg-white/10">Download</button>
                                {(file.type === 'audio' || file.type === 'video') && (
                                  <button onClick={() => setPlayingFileId(file.id)} className="rounded-xl border border-orange-400/20 bg-orange-500/10 px-3 py-2 text-xs text-orange-200 transition hover:bg-orange-500/20">
                                    <span className="flex items-center gap-2"><Play size={14} /> Preview</span>
                                  </button>
                                )}
                                <button onClick={() => handleDeleteFile(file.id)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-neutral-400 transition hover:bg-white/10 hover:text-white">
                                  <span className="flex items-center gap-2"><Trash2 size={14} /> Remove</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'lyrics' && (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,1fr)]">
                <section className="rounded-[28px] border border-white/10 bg-black/25 p-6 shadow-2xl shadow-black/20">
                  <div className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-xl font-semibold text-white">Lyrics Workspace</h3>
                      <p className="mt-1 text-sm text-neutral-400">Every keystroke syncs to everyone else in this room.</p>
                      <p className="mt-2 text-xs uppercase tracking-[0.22em] text-neutral-500">
                        {activeEditors.length > 0 ? `Editing now: ${activeEditors.join(', ')}` : 'Nobody is editing right now'}
                      </p>
                    </div>
                    <div className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs uppercase tracking-[0.22em] text-emerald-200">{isSavingLyrics ? 'Syncing' : 'Live'}</div>
                  </div>

                  <textarea
                    value={draftLyrics}
                    onChange={(event) => handleLyricsChange(event.target.value)}
                    onFocus={handleLyricsFocus}
                    onBlur={handleLyricsBlur}
                    className="min-h-[520px] w-full rounded-3xl border border-white/10 bg-black/40 p-5 font-mono text-sm leading-7 text-neutral-100 outline-none transition focus:border-orange-400"
                    placeholder="Write verses, chorus markers, and direction notes here..."
                  />
                </section>

                <section className="rounded-[28px] border border-white/10 bg-black/25 p-6 shadow-2xl shadow-black/20">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-4 text-white">
                    <MessageSquare size={16} className="text-orange-300" />
                    <h3 className="font-semibold">Room Chat</h3>
                  </div>
                  <form onSubmit={handleAddNote} className="mb-5">
                    <div className="flex gap-2">
                      <input
                        value={newNote}
                        onChange={(event) => setNewNote(event.target.value)}
                        placeholder="Capture direction, feedback, or next steps..."
                        className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400"
                      />
                      <button type="submit" className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-medium text-black transition hover:bg-orange-400">Send</button>
                    </div>
                  </form>

                  <div className="space-y-3">
                    {currentData.notes.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-5 text-sm text-neutral-500">No messages yet for this room.</div>
                    ) : (
                      currentData.notes.map((note) => {
                        const isOwnMessage = note.author === ownDisplayName;

                        return (
                          <article key={note.id} className={`rounded-2xl border p-4 ${isOwnMessage ? 'ml-8 border-orange-400/20 bg-orange-500/10' : 'mr-8 border-white/10 bg-white/5'}`}>
                            <div className="flex items-center justify-between gap-3">
                              <strong className="text-sm text-orange-200">{note.author}</strong>
                              <span className="text-xs uppercase tracking-[0.18em] text-neutral-500">{formatDateLabel(note.createdAt)}</span>
                            </div>
                            <p className="mt-2 text-sm leading-6 text-neutral-300">{note.text}</p>
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'suno prompts' && (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)]">
                <section className="rounded-[28px] border border-white/10 bg-black/25 p-6 shadow-2xl shadow-black/20">
                  <div className="mb-5 flex items-center gap-3 border-b border-white/10 pb-4">
                    <Sparkles size={18} className="text-orange-300" />
                    <div>
                      <h3 className="text-xl font-semibold text-white">Prompt Library</h3>
                      <p className="mt-1 text-sm text-neutral-400">Keep tested prompt variants instead of losing them in chat history.</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {currentData.prompts.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-center text-neutral-500">No prompts saved for this project yet.</div>
                    ) : (
                      currentData.prompts.map((prompt) => (
                        <article key={prompt.id} className="rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:bg-white/10">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <h4 className="text-lg font-semibold text-orange-200">{prompt.ver}</h4>
                              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-neutral-500">Generated {prompt.date}</p>
                            </div>
                            <button onClick={() => copyPrompt(prompt.text)} className="rounded-2xl border border-white/10 px-3 py-2 text-xs text-neutral-200 transition hover:bg-white/10">
                              <span className="flex items-center gap-2"><Copy size={14} /> Copy Prompt</span>
                            </button>
                          </div>
                          <div className="mt-4 rounded-2xl border border-white/10 bg-black/35 p-4 font-mono text-sm leading-7 text-neutral-200">{prompt.text}</div>
                        </article>
                      ))
                    )}
                  </div>
                </section>

                <section className="rounded-[28px] border border-white/10 bg-black/25 p-6 shadow-2xl shadow-black/20">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-4 text-white">
                    <Plus size={16} className="text-orange-300" />
                    <h3 className="font-semibold">Add Prompt</h3>
                  </div>
                  <form onSubmit={handleAddPrompt} className="space-y-3">
                    <input
                      value={newPromptVersion}
                      onChange={(event) => setNewPromptVersion(event.target.value)}
                      placeholder="Version label, for example Iteration #5"
                      className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400"
                    />
                    <textarea
                      value={newPrompt}
                      onChange={(event) => setNewPrompt(event.target.value)}
                      placeholder="Describe style, energy, instrumentation, vocal direction, exclusions, and intent..."
                      className="min-h-[220px] w-full rounded-3xl border border-white/10 bg-black/40 px-4 py-4 text-sm leading-6 text-white outline-none transition focus:border-orange-400"
                    />
                    <button type="submit" className="w-full rounded-2xl bg-orange-500 px-4 py-3 text-sm font-medium text-black transition hover:bg-orange-400">Save Prompt</button>
                  </form>
                </section>
              </div>
            )}
          </div>
        </main>
      </div>

      {playingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur">
          <div className="w-full max-w-4xl overflow-hidden rounded-[32px] border border-white/10 bg-[#0b0b0b] shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                {renderIcon(playingFile.type)}
                <div className="min-w-0">
                  <div className="truncate text-base font-medium text-white">{playingFile.name}</div>
                  <div className="text-xs uppercase tracking-[0.18em] text-neutral-500">{formatBytes(playingFile.size)}</div>
                </div>
              </div>
              <button onClick={() => setPlayingFileId(null)} className="rounded-full border border-white/10 p-2 text-neutral-300 transition hover:bg-white/10 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="flex min-h-[420px] items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(249,115,22,0.15),_transparent_34%),linear-gradient(180deg,_#121212_0%,_#050505_100%)] p-6">
              {playingFile.type === 'video' ? (
                <video src={apiUrl(playingFile.url)} controls autoPlay className="max-h-[70vh] w-full rounded-3xl bg-black" />
              ) : (
                <div className="w-full max-w-2xl rounded-[28px] border border-white/10 bg-black/35 p-6 text-center">
                  <div className="mb-6 flex items-center justify-center gap-2 text-orange-200">
                    <Play size={18} />
                    <span className="text-sm uppercase tracking-[0.22em]">Audio Preview</span>
                  </div>
                  <audio src={apiUrl(playingFile.url)} controls autoPlay className="w-full" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
