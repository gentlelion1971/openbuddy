// TasksView.swift
// The to-do list from the PC (GET /api/tasks). Read-only in v0.1.0: tasks
// are created and completed on the desktop or by the agent.

import SwiftUI

struct TasksView: View {
    @EnvironmentObject private var appState: AppState

    @State private var tasks: [TaskItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading && tasks.isEmpty {
                ProgressView("Loading tasks…")
            } else if let errorMessage, tasks.isEmpty {
                ContentUnavailableView {
                    Label("Could not load tasks", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Retry") { Task { await loadTasks() } }
                }
            } else if tasks.isEmpty {
                ContentUnavailableView {
                    Label("No tasks", systemImage: "checklist")
                } description: {
                    Text("Tasks you create on your computer, or ask the agent to track, appear here.")
                }
            } else {
                List {
                    ForEach(tasks) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Image(systemName: statusIcon(for: task.status))
                                    .foregroundStyle(statusColor(for: task.status))
                                Text(task.title)
                                    .font(.headline)
                            }
                            HStack(spacing: 8) {
                                Text(task.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if let dueAt = task.dueAt {
                                    Text("Due \(DisplayDate.relativeString(dueAt))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .refreshable { await loadTasks() }
            }
        }
        .navigationTitle("Tasks")
        .task { await loadTasks() }
    }

    private func loadTasks() async {
        isLoading = true
        defer { isLoading = false }
        do {
            tasks = try await appState.api.fetchTasks()
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func statusIcon(for status: String) -> String {
        switch status.lowercased() {
        case "done", "completed": return "checkmark.circle.fill"
        case "in_progress", "in-progress", "active": return "circle.dotted"
        default: return "circle"
        }
    }

    private func statusColor(for status: String) -> Color {
        switch status.lowercased() {
        case "done", "completed": return .green
        case "in_progress", "in-progress", "active": return .blue
        default: return .secondary
        }
    }
}
