# Projects are not deduplicated by directory

Multiple projects may reference the same project directory because a project is the user's durable organizing context, not just a filesystem path. Sessions are permanently attached to the project that created them, so directory reuse must not merge histories or move sessions between projects.
