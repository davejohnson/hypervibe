void
warn_on_mount_point(int error)
{
	if (error == 2)
		pg_log_error_detail("It contains a dot-prefixed/invisible file, perhaps due to it being a mount point.");
	else if (error == 3)
		pg_log_error_detail("It contains a lost+found directory, perhaps due to it being a mount point.");

	pg_log_error_hint("Using a mount point directly as the data directory is not recommended.\n"
					  "Create a subdirectory under the mount point.");
}


