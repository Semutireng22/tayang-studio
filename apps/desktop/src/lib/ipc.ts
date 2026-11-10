import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { captureAiApiCheck, registerAiAgent, startAiGeneration } from '@/lib/analytics';
import type {
  AgentId,
  ApiCheck,
  ApiProvider,
  AgentInfo,
  AgentUsage,
  ChatTrace,
  Autopilot,
  NichesResponse,
  VoicesResponse,
  AutopilotInput,
  AutopilotSlot,
  Chat,
  ChatMessage,
  FileInfo,
  Job,
  MediaInfo,
  MessagePart,
  ModelChoice,
  NewProject,
  Project,
  ProjectStatus,
  RecentChat,
  Settings,
  SlotPatch,
  Style,
  SystemInfo,
  ToolStatus,
  QuestionResponse,
} from '@tayang/shared';

// ---- system and settings ----

// Your API: the user's own provider key, run on the opencode engine Tayang downloads (api_engine.rs).
export interface ApiStatus {
  provider: ApiProvider | null;
  hasKey: boolean;
  engineInstalled: boolean;
}
export const apiStatus = () => invoke<ApiStatus>('api_status');
/** Lists the models at `baseUrl`, which checks the key too; no `key` checks the saved one. */
export const apiCheck = (baseUrl: string, key: string | null) => invoke<ApiCheck>('api_check', { baseUrl, key });
/** One real one-token call with `model` before saving; no `key` uses the saved one. */
export const apiTry = async (baseUrl: string, key: string | null, model: string) => {
  const startedAt = Date.now();
  try {
    const result = await invoke<ApiCheck>('api_try', { baseUrl, key, model });
    captureAiApiCheck(model, startedAt, result.ok);
    return result;
  } catch (error) {
    captureAiApiCheck(model, startedAt, false);
    throw error;
  }
};
export const apiReachable = (baseUrl: string) => invoke<boolean>('api_reachable', { baseUrl });
/** Saves the provider (and the key, when given) and makes Your API the default agent. */
export const apiSave = (provider: ApiProvider, key: string | null) => invoke<Settings>('api_save', { provider, key });
export const apiClear = () => invoke<Settings>('api_clear');
/** Downloads the engine unless it's there; progress comes as `ENGINE_PROGRESS_EVENT`. */
export const engineInstall = () => invoke<void>('engine_install');
export const ENGINE_PROGRESS_EVENT = 'engine://progress';
export interface EngineProgress {
  done: number;
  total: number | null;
}
export const getSystemInfo = () => invoke<SystemInfo>('get_system_info');
export const detectAgents = () => invoke<AgentInfo[]>('detect_agents');
export const checkTools = (agent: AgentId) => invoke<ToolStatus[]>('check_tools', { agent });
export const getSettings = () => invoke<Settings>('get_settings');
/** TAYANG_API_URL when the app was started with it: it wins over the API address in Settings. */
export const apiUrlOverride = () => invoke<string | null>('api_url_override');
export const updateSettings = (patch: Partial<Settings>) =>
  invoke<Settings>('update_settings', { patch });
/** The operating system's preferred language (`id-ID`), or null when it can't be read. */
export const systemLocale = () => invoke<string | null>('system_locale');
export const pickFolder = () => invoke<string | null>('pick_folder');

// ---- usage ----
export const getAgentUsage = (force: boolean) => invoke<AgentUsage[]>('get_agent_usage', { force });
export const getChatTrace = (chatId: string) => invoke<ChatTrace>('get_chat_trace', { chatId });

// ---- projects ----
export const listProjects = () => invoke<Project[]>('list_projects');
export const createProject = (input: NewProject, brief: string) =>
  invoke<Project>('create_project', { input, brief });
export const updateProject = (id: string, patch: Partial<Project>) =>
  invoke<Project>('update_project', { id, patch });
/** Moves a project to `status` (draft → building → rendered); it never goes back unless `reset`. */
export const setProjectStatus = (projectId: string, status: ProjectStatus, reset = false) =>
  invoke<Project>('set_project_status', { projectId, status, reset });
export const setSchedule = (projectId: string, at: string | null) =>
  invoke<Project>('set_schedule', { projectId, at });
/** One video of a confirmed schedule card: an existing one by id, or a new draft with its brief. */
export type BatchItem = { projectId: string; at: string } | { at: string; draft: { input: NewProject; brief: string } };
/**
 * Schedules a whole card or nothing: Rust checks every item, then writes, and undoes it all when a write
 * fails. Errors are `schedule:<code>[:n]`.
 */
export const scheduleVideos = (items: BatchItem[]) => invoke<Project[]>('schedule_videos', { items });
export const setPosted = (projectId: string, posted: boolean) =>
  invoke<Project>('set_posted', { projectId, posted });
export const approveProject = (projectId: string) => invoke<Project>('approve_project', { projectId });

// ---- autopilots ----
/** What the wizard offers; both come from the API, so they fail while offline. */
export const listNiches = () => invoke<NichesResponse>('list_niches').then((r) => r.niches ?? []);
export const listVoices = () => invoke<VoicesResponse>('list_voices').then((r) => r.voices ?? []);
export const listAutopilots = () => invoke<Autopilot[]>('list_autopilots');
/** Creates (no id) or edits (with id) an autopilot; a new one starts active, an edit keeps its status. */
export const saveAutopilot = (input: AutopilotInput) => invoke<Autopilot>('save_autopilot', { input });
/** Removes the autopilot and its slots that made no video; the videos stay. */
export const deleteAutopilot = (id: string) => invoke<void>('delete_autopilot', { id });
export const setAutopilotStatus = (id: string, status: Autopilot['status']) =>
  invoke<Autopilot>('set_autopilot_status', { id, status });
/** Slots due between two RFC 3339 instants, both included. */
export const listSlots = (from: string, to: string) => invoke<AutopilotSlot[]>('list_slots', { from, to });
/** Makes sure a planned slot exists for (autopilot, dueAt); an existing slot comes back unchanged. */
export const upsertSlot = (autopilotId: string, dueAt: string) =>
  invoke<AutopilotSlot>('upsert_slot', { autopilotId, dueAt });
export const updateSlot = (id: string, patch: SlotPatch) => invoke<AutopilotSlot>('update_slot', { id, patch });

// ---- chats ----
export const listChats = (projectId?: string) =>
  invoke<Chat[]>('list_chats', { projectId: projectId ?? null });
/** Chats with and without a project, newest activity first; all of them without a limit. */
export const listRecentChats = (limit?: number) => invoke<RecentChat[]>('list_recent_chats', { limit: limit ?? null });
export const listArchivedChats = () => invoke<RecentChat[]>('list_archived_chats');
/** Archives or restores the thread a chat belongs to (every chat of its project). */
export const setThreadArchived = (chatId: string, archived: boolean) => invoke<void>('set_thread_archived', { chatId, archived });
/** Deletes archived chats and cards for good; projects and their videos stay. */
export const purgeArchive = () => invoke<{ chats: number; cards: number }>('purge_archive');
export const getChat =(chatId: string) => invoke<Chat | null>('get_chat', { chatId });
export const createChat = (projectId: string | null, agentId: AgentId, title: string) =>
  invoke<Chat>('create_chat', { projectId, agentId, title });
export const updateChatAgent = (chatId: string, agentId: AgentId) =>
  invoke<Chat>('update_chat_agent', { chatId, agentId });
export const listMessages = (chatId: string) => invoke<ChatMessage[]>('list_messages', { chatId });
export const addMessage = (chatId: string, role: ChatMessage['role'], parts: MessagePart[]) =>
  invoke<ChatMessage>('add_message', { chatId, role, parts });

// ---- styles ----
export const listStyles = () => invoke<Style[]>('list_styles');
/** What `sync_styles` returns: the built-in styles now in the library, and whether the API was out of reach. */
export interface StylesSync {
  styles: Style[];
  offline: boolean;
}
export const syncStyles = () => invoke<StylesSync>('sync_styles');
export const installStyleTemplate = (projectId: string) =>
  invoke<{ installed: boolean }>('install_style_template', { projectId });
export const saveStyle = (style: Style) => invoke<void>('save_style', { style });
export const deleteStyle = (id: string) => invoke<void>('delete_style', { id });
export const readStyleResult = (studyId: string) =>
  invoke<string | null>('read_style_result', { studyId });
export const studyDir = (studyId: string) => invoke<string>('study_dir', { studyId });
/** Deletes a study's folder (the download, frames and result) once the study is over. */
export const removeStudyDir = (studyId: string) => invoke<void>('remove_study_dir', { studyId });
/** Cuts a short silent clip and a poster from the study's downloaded video, then deletes that video. */
export const makeStylePreview = (studyId: string, styleId: string) =>
  invoke<{ previewPath: string | null; posterPath: string } | null>('make_style_preview', { studyId, styleId });
export const makeStyleSheets = (studyId: string, styleId: string) => invoke<string[]>('make_style_sheets', { studyId, styleId });
export const keepStyleRefs = (studyId: string, styleId: string) => invoke<string[]>('keep_style_refs', { studyId, styleId });
export const copyStyleRefs = (styleId: string, projectId: string) => invoke<number>('copy_style_refs', { styleId, projectId });

// ---- jobs ----
export const listJobs = () => invoke<Job[]>('list_jobs');
export const upsertJob = (job: Job) => invoke<void>('upsert_job', { job });
export const deleteJob = (id: string) => invoke<void>('delete_job', { id });
export const setJobsArchived = (ids: string[], archived: boolean) => invoke<void>('set_jobs_archived', { ids, archived });

// ---- agent ----
/** Resolves true when Claude started without the Tayang plugin: send it the skills as text too. */
export const agentStart = (chatId: string, agentId: AgentId, auto?: boolean) =>
  invoke<boolean>('agent_start', auto === undefined ? { chatId, agentId } : { chatId, agentId, auto }).then((result) => {
    registerAiAgent(chatId, agentId);
    return result;
  });
/** Auto mode for the running session: the agent runs commands without asking. */
export const agentSetAuto = (chatId: string, on: boolean) => invoke<void>('agent_set_auto', { chatId, on });
export const agentPrompt = (chatId: string, parts: MessagePart[]) =>
  invoke<void>('agent_prompt', { chatId, parts }).then(() => startAiGeneration(chatId));
export const agentCancel = (chatId: string) => invoke<void>('agent_cancel', { chatId });
export const agentStop = (chatId: string) => invoke<void>('agent_stop', { chatId });
export const agentRespondPermission = (requestId: string, optionId: string | null) =>
  invoke<void>('agent_respond_permission', { requestId, optionId });
/** Answers an agent's question (ACP elicitation). */
export const agentRespondQuestion = (requestId: string, response: QuestionResponse) =>
  invoke<void>('agent_respond_question', { requestId, response });

// ---- media ----
export const mediaLatestRender = (projectId: string) =>
  invoke<string | null>('media_latest_render', { projectId });
/** Images the agent made in a project chat's folder since `since` (RFC 3339), newest first; none without a project. */
export const recentImages = (chatId: string, since: string, limit: number) =>
  invoke<FileInfo[]>('recent_images', { chatId, since, limit });
/** The newest render with its size and time; null when the project has none. */
/** Shows a video in the file manager: its newest render selected, or its project folder without one. */
export const showVideoInFolder = (projectId: string) => invoke<void>('show_video_in_folder', { projectId });
export const latestRenderInfo = (projectId: string) => invoke<FileInfo | null>('latest_render_info', { projectId });
/** The newest mp4 where renders land (renders/, the root, out/, runs/<run>/out/), still-empty ones too (a render being written); null when there is none. */
export const newestVideoInfo = (projectId: string) => invoke<FileInfo | null>('newest_video_info', { projectId });
/** One frame of a project's newest render, cached by the render's time; `modifiedAt` busts the image cache. */
export interface VideoThumb {
  path: string;
  modifiedAt: string;
  durationSec: number | null;
}
/** The Videos card's frame of the newest render; null without a render or ffmpeg. */
export const videoThumbnail = (projectId: string) => invoke<VideoThumb | null>('video_thumbnail', { projectId });
export const mediaProbe = (projectId: string) =>
  invoke<MediaInfo | null>('media_probe', { projectId });
export const mediaExtractFrame = (projectId: string, timeSec: number) =>
  invoke<string>('media_extract_frame', { projectId, timeSec });
export const mediaThumbnails = (projectId: string, count: number) =>
  invoke<string[]>('media_thumbnails', { projectId, count });
export interface RenderCommand {
  install: string[] | null;
  render: string[];
}
export const renderCommand = (projectId: string) => invoke<RenderCommand | null>('render_command', { projectId });
export const writeBrief = (projectId: string, brief: string) => invoke<void>('write_brief', { projectId, brief });
export const mediaRender = (projectId: string) => invoke<string>('media_render', { projectId });

/** URL the webview can load for a file on disk. */
export const assetUrl = (path: string): string => convertFileSrc(path);

// ---- attachments ----
export const attachFile = (chatId: string, sourcePath: string) =>
  invoke<Extract<MessagePart, { type: 'file' }>>('attach_file', { chatId, sourcePath });

// ---- project files (the workspace) ----

/** A file or folder in a project, `path` relative to the project folder with `/` between parts. */
export interface ProjectFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  /** A dot file, or a dependency or build folder (or inside one). */
  dim: boolean;
}
export type ProjectFileKind = 'text' | 'image' | 'video' | 'audio' | 'binary' | 'tooLarge';
export interface ProjectFileContent {
  kind: ProjectFileKind;
  absPath: string;
  size: number;
  text: string | null;
}
/** One folder of a project ("" is the top), folders first. */
export const projectFiles = (projectId: string, dir = '') => invoke<ProjectFile[]>('project_files', { projectId, dir });
/** Files whose name contains `query`; dependency and dot folders are not searched. */
export const findProjectFiles = (projectId: string, query: string) => invoke<ProjectFile[]>('find_project_files', { projectId, query });
export const readProjectFile = (projectId: string, path: string) => invoke<ProjectFileContent>('read_project_file', { projectId, path });

// ---- agent models ----

export interface AgentModels {
  current: string | null;
  options: ModelChoice[];
}
/** The models an agent offers, read from a short session in a scratch folder; null when it reports none. */
export const agentModels = (agentId: AgentId) => invoke<AgentModels | null>('agent_models', { agentId });
/** Picks the agent's model (null: its own default); a running session of `chatId` switches now. */
export const setAgentModel = (agentId: AgentId, model: string | null, chatId: string | null) =>
  invoke<Settings>('set_agent_model', { agentId, model, chatId });
