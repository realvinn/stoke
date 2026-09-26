/*
 * libuv's thread pool, sized before anything uses it. Imported FIRST by
 * index.ts: the pool is created on its first use and reads this variable once,
 * so a line anywhere later is a line that does nothing.
 *
 * Every async `fs` call in main runs on this pool, and so does every keystroke
 * sent to a session — node-pty writes to the pty through `fs.write`. At the
 * default four threads, four slow file operations (a sleeping external disk,
 * a cold transcript read) are enough to make typing wait for them, and the
 * event loop shows nothing wrong while it happens. `probe` in projects.ts caps
 * how many threads a sleeping disk can take; this is the headroom around it.
 * An explicit value in the environment still wins.
 */
process.env.UV_THREADPOOL_SIZE ??= '16'
