import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  CHANNELS,
  type DesktopEvent,
  type FolioApi,
  type InvokeMethod,
  type InvokeResult,
} from "./api.ts";

async function call<T>(method: InvokeMethod, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(CHANNELS.invoke, method, ...args)) as InvokeResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const api: FolioApi = {
  bootstrap: () => call("bootstrap"),
  openChat: (id) => call("openChat", id),
  send: (input) => call("send", input),
  cancel: (chatId) => call("cancel", chatId),
  setFocus: (chatId, focus) => call("setFocus", chatId, focus),
  signIn: () => call("signIn"),
  cancelSignIn: () => call("cancelSignIn"),
  signOut: () => call("signOut"),
  saveKey: (connection, key) => call("saveKey", connection, key),
  removeKey: (connection) => call("removeKey", connection),
  setRoleModel: (role, ref) => call("setRoleModel", role, ref),
  setOpenRouterModels: (ids) => call("setOpenRouterModels", ids),
  openrouterCatalog: () => call("openrouterCatalog"),
  revealConfig: () => call("revealConfig"),
  listCourses: () => call("listCourses"),
  createCourse: (input) => call("createCourse", input),
  updateCourse: (id, patch, revision) => call("updateCourse", id, patch, revision),
  listDocuments: (courseId) => call("listDocuments", courseId),
  importFiles: (courseId, paths, role) => call("importFiles", courseId, paths, role),
  chooseFiles: (courseId) => call("chooseFiles", courseId),
  updateDocument: (id, patch, revision) => call("updateDocument", id, patch, revision),
  readDocument: (id) => call("readDocument", id),
  listNotes: (courseId) => call("listNotes", courseId),
  readNote: (id) => call("readNote", id),
  createNote: (courseId, title) => call("createNote", courseId, title),
  saveNote: (id, content, revision) => call("saveNote", id, content, revision),
  noteHistory: (id) => call("noteHistory", id),
  restoreNote: (id, version, revision) => call("restoreNote", id, version, revision),
  appendToNote: (id, text) => call("appendToNote", id, text),
  searchNotes: (query, courseId) => call("searchNotes", query, courseId),
  noteMentions: (id) => call("noteMentions", id),
  linkMention: (source, target, revision) => call("linkMention", source, target, revision),
  listProposals: () => call("listProposals"),
  resolveProposal: (id, action) => call("resolveProposal", id, action),
  scanFolder: (path) => call("scanFolder", path),
  readSyllabus: (path) => call("readSyllabus", path),
  listJobs: () => call("listJobs"),
  startIngest: (courseId, documentIds) => call("startIngest", courseId, documentIds),
  pauseJob: (id) => call("pauseJob", id),
  resumeJob: (id) => call("resumeJob", id),
  cancelJob: (id) => call("cancelJob", id),
  dismissJob: (id) => call("dismissJob", id),
  knowledge: (courseId) => call("knowledge", courseId),
  studyNotes: (courseId) => call("studyNotes", courseId),
  rollbackKnowledge: (courseId) => call("rollbackKnowledge", courseId),
  trashDocuments: (ids) => call("trashDocuments", ids),
  trashNote: (id) => call("trashNote", id),
  listAssignments: () => call("listAssignments"),
  createAssignment: (input) => call("createAssignment", input),
  updateAssignment: (id, patch, revision) => call("updateAssignment", id, patch, revision),
  addAssignmentFiles: (id, into, revision, note) =>
    call("addAssignmentFiles", id, into, revision, note),
  openAssignmentFile: (id, fileId) => call("openAssignmentFile", id, fileId),
  trashAssignment: (id) => call("trashAssignment", id),
  trashChat: (id) => call("trashChat", id),
  trashCourse: (id) => call("trashCourse", id),
  listTrash: () => call("listTrash"),
  restoreFromTrash: (id) => call("restoreFromTrash", id),
  deleteFromTrash: (id) => call("deleteFromTrash", id),
  emptyTrash: () => call("emptyTrash"),
  registerArtifact: (input) => call("registerArtifact", input),
  saveFile: (file) => call("saveFile", file),
  loadWorkspace: () => call("loadWorkspace"),
  saveWorkspace: (state) => call("saveWorkspace", state),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent(listener) {
    const handler = (_event: IpcRendererEvent, event: DesktopEvent) => listener(event);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("folio", api);
