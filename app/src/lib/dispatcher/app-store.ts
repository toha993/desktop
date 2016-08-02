import { Emitter, Disposable } from 'event-kit'
import { IRepositoryState, IHistoryState, IHistorySelection, IAppState, RepositorySection, IChangesState } from '../app-state'
import User from '../../models/user'
import Repository from '../../models/repository'
import { FileChange, WorkingDirectoryStatus, WorkingDirectoryFileChange } from '../../models/status'
import { LocalGitOperations, Commit } from '../local-git-operations'
import { findIndex } from '../find'

/** The number of commits to load from history per batch. */
const CommitBatchSize = 100

export default class AppStore {
  private emitter = new Emitter()

  private users: ReadonlyArray<User> = new Array<User>()
  private repositories: ReadonlyArray<Repository> = new Array<Repository>()
  private selectedRepository: Repository | null

  private repositoryState = new Map<number, IRepositoryState>()

  private emitQueued = false

  private emitUpdate() {
    if (this.emitQueued) { return }

    this.emitQueued = true

    window.requestAnimationFrame(() => {
      this.emitter.emit('did-update', this.getState())
      this.emitQueued = false
    })
  }

  public onDidUpdate(fn: (state: IAppState) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  private getInitialRepositoryState(): IRepositoryState {
    return {
      historyState: {
        selection: {
          commit: null,
          file: null,
        },
        commits: new Array<Commit>(),
        commitCount: 0,
        changedFiles: new Array<FileChange>(),
        loading: false,
      },
      changesState: {
        workingDirectory: new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true),
        selectedFile: null,
      },
      selectedSection: RepositorySection.History,
      branch: null,
    }
  }

  private getRepositoryState(repository: Repository): IRepositoryState {
    let state = this.repositoryState.get(repository.id!)
    if (state) { return state }

    state = this.getInitialRepositoryState()
    this.repositoryState.set(repository.id!, state)
    return state
  }

  private updateRepositoryState(repository: Repository, fn: (state: IRepositoryState) => IRepositoryState) {
    const currentState = this.getRepositoryState(repository)
    this.repositoryState.set(repository.id!, fn(currentState))
  }

  private updateHistoryState(repository: Repository, fn: (historyState: IHistoryState) => IHistoryState) {
    this.updateRepositoryState(repository, state => {
      const historyState = fn(state.historyState)
      return {
        historyState,
        changesState: state.changesState,
        selectedSection: state.selectedSection,
        branch: state.branch,
      }
    })
  }

  private updateChangesState(repository: Repository, fn: (changesState: IChangesState) => IChangesState) {
    this.updateRepositoryState(repository, state => {
      const changesState = fn(state.changesState)
      return {
        historyState: state.historyState,
        changesState,
        selectedSection: state.selectedSection,
        branch: state.branch,
      }
    })
  }

  private getCurrentRepositoryState(): IRepositoryState | null {
    const repository = this.selectedRepository
    if (!repository) { return null }

    return this.getRepositoryState(repository)
  }

  public getState(): IAppState {
    return {
      users: this.users,
      repositories: this.repositories,
      repositoryState: this.getCurrentRepositoryState(),
      selectedRepository: this.selectedRepository,
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadHistory(repository: Repository): Promise<void> {
    this.updateHistoryState(repository, state => {
      return {
        commits: state.commits,
        selection: state.selection,
        changedFiles: state.changedFiles,
        commitCount: state.commitCount,
        loading: true
      }
    })
    this.emitUpdate()

    const commits = await LocalGitOperations.getHistory(repository, 'HEAD', CommitBatchSize)
    const commitCount = await LocalGitOperations.getCommitCount(repository)

    this.updateHistoryState(repository, state => {
      return {
        commits,
        selection: state.selection,
        changedFiles: state.changedFiles,
        commitCount,
        loading: false,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadNextHistoryBatch(repository: Repository): Promise<void> {
    const state = this.getRepositoryState(repository)
    if (state.historyState.loading) {
      return
    }

    this.updateHistoryState(repository, state => {
      return {
        commits: state.commits,
        selection: state.selection,
        changedFiles: state.changedFiles,
        commitCount: state.commitCount,
        loading: true
      }
    })
    this.emitUpdate()

    const lastCommit = state.historyState.commits[state.historyState.commits.length - 1]
    const commits = await LocalGitOperations.getHistory(repository, `${lastCommit.sha}^`, CommitBatchSize)

    this.updateHistoryState(repository, state => {
      return {
        commits: state.commits.concat(commits),
        selection: state.selection,
        changedFiles: state.changedFiles,
        commitCount: state.commitCount,
        loading: false,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadChangedFilesForCurrentSelection(repository: Repository): Promise<void> {
    const state = this.getRepositoryState(repository)
    const selection = state.historyState.selection
    const currentCommit = selection.commit
    if (!currentCommit) { return }

    const changedFiles = await LocalGitOperations.getChangedFiles(repository, currentCommit.sha)

    // The selection could have changed between when we started loading the
    // changed files and we finished. We might wanna store the changed files per
    // SHA/path.
    if (currentCommit !== state.historyState.selection.commit) {
      return
    }

    this.updateHistoryState(repository, state => {
      return {
        commits: state.commits,
        selection,
        changedFiles,
        commitCount: state.commitCount,
        loading: state.loading,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeHistorySelection(repository: Repository, selection: IHistorySelection): Promise<void> {
    this.updateHistoryState(repository, state => {
      const commitChanged = state.selection.commit !== selection.commit
      const changedFiles = commitChanged ? new Array<FileChange>() : state.changedFiles

      return {
        commits: state.commits,
        selection,
        changedFiles,
        commitCount: state.commitCount,
        loading: state.loading,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _selectRepository(repository: Repository | null): Promise<void> {
    this.selectedRepository = repository
    this.emitUpdate()

    if (!repository) { return Promise.resolve() }

    return this._refreshRepository(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _loadFromSharedProcess(users: ReadonlyArray<User>, repositories: ReadonlyArray<Repository>) {
    this.users = users
    this.repositories = repositories

    const selectedRepository = this.selectedRepository
    let newSelectedRepository: Repository | null = this.selectedRepository
    if (selectedRepository) {
      const i = findIndex(this.repositories, r => r.id === selectedRepository.id)
      if (i === -1) {
        newSelectedRepository = null
      }
    }

    if (!this.selectedRepository && this.repositories.length > 0) {
      newSelectedRepository = this.repositories[0]
    }

    if (newSelectedRepository !== selectedRepository) {
      this._selectRepository(newSelectedRepository)
    }

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadStatus(repository: Repository): Promise<void> {
    let workingDirectory = new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true)
    try {
      const status = await LocalGitOperations.getStatus(repository)
      workingDirectory = status.workingDirectory
    } catch (e) {
      console.error(e)
    }

    this.updateChangesState(repository, state => {
      return {
        workingDirectory,
        selectedFile: null,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeRepositorySection(repository: Repository, section: RepositorySection): Promise<void> {
    this.updateRepositoryState(repository, state => {
      return {
        historyState: state.historyState,
        changesState: state.changesState,
        selectedSection: section,
        branch: state.branch,
      }
    })
    this.emitUpdate()

    if (section === RepositorySection.History) {
      return this._loadHistory(repository)
    } else if (section === RepositorySection.Changes) {
      return this._loadStatus(repository)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeChangesSelection(repository: Repository, selectedFile: WorkingDirectoryFileChange | null): Promise<void> {
    this.updateChangesState(repository, state => {
      return {
        workingDirectory: state.workingDirectory,
        selectedFile,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _commitIncludedChanges(repository: Repository, title: string): Promise<void> {
    const state = this.getRepositoryState(repository)
    const files = state.changesState.workingDirectory.files.filter(function(file, index, array) {
      return file.include === true
    })

    await LocalGitOperations.createCommit(repository, title, files)

    return this._loadStatus(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeFileIncluded(repository: Repository, file: WorkingDirectoryFileChange, include: boolean): Promise<void> {
    this.updateRepositoryState(repository, state => {
      const newFiles = state.changesState.workingDirectory.files.map(f => {
        if (f.id === file.id) {
          return f.withInclude(include)
        } else {
          return f
        }
      })

      const allSelected = newFiles.every(f => f.include)
      const noneSelected = newFiles.every(f => !f.include)

      let includeAll: boolean | null = null
      if (allSelected) {
        includeAll = true
      } else if (noneSelected) {
        includeAll = false
      }

      return {
        selectedSection: state.selectedSection,
        changesState: {
          workingDirectory: new WorkingDirectoryStatus(newFiles, includeAll),
          selectedFile: state.changesState.selectedFile,
        },
        historyState: state.historyState,
        branch: state.branch,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeIncludeAllFiles(repository: Repository, includeAll: boolean): Promise<void> {
    this.updateChangesState(repository, state => {
      return {
        workingDirectory: state.workingDirectory.withIncludeAllFiles(includeAll),
        selectedFile: state.selectedFile,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  private async refreshCurrentBranch(repository: Repository): Promise<void> {
    const branch = await LocalGitOperations.getCurrentBranch(repository)

    this.updateRepositoryState(repository, state => {
      return {
        selectedSection: state.selectedSection,
        changesState: state.changesState,
        historyState: state.historyState,
        branch,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _refreshRepository(repository: Repository): Promise<void> {
    const state = this.getRepositoryState(repository)

    await this.refreshCurrentBranch(repository)

    // When refreshing we *always* load Changes so that we can update the
    // changes indicator in the tab bar. But we only load History if it's
    // selected.
    await this._loadStatus(repository)

    const section = state.selectedSection
    if (section === RepositorySection.History) {
      return this._loadHistory(repository)
    }
  }
}
