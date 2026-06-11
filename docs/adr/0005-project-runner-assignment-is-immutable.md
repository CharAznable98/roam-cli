# Project runner assignment is immutable

A project cannot be moved to a different runner after creation because its project directory is a runner-perspective path. Switching runners would reinterpret the same path string in another filesystem context, so users create a new project instead.
