/*
 * sworm-setup: native installer for the sworm agent.
 *
 * A tiny C program for machines where running a shell or PowerShell
 * installer is awkward, for example a locked-down Windows laptop where
 * you want a plain .exe to run. It does exactly what
 * install/install.sh and install/install.ps1 do:
 *
 *   1. Checks for node.js 18 or newer (the agent is a node program).
 *   2. Creates ~/.sworm.
 *   3. Puts the agent at ~/.sworm/agent.js: copies a local file when
 *      one is configured or found in the current directory, otherwise
 *      downloads it from your worker.
 *   4. Writes ~/.sworm/config.json (worker url and bootstrap token).
 *   5. Starts the agent in the background.
 *
 * The agent then enrolls the machine and installs its own persistence:
 * a LaunchAgent named com.sworm.agent on macOS, a scheduled task named
 * SwormAgent on Windows, one tagged cron line on linux.
 *
 * Every step is printed. Any failure exits nonzero with a message.
 *
 * Configuration, in priority order:
 *   1. environment variables SWORM_WORKER_URL, SWORM_BOOTSTRAP_TOKEN,
 *      SWORM_AGENT_URL, SWORM_AGENT_FILE
 *   2. the three placeholders below (fill them before distributing,
 *      the same way the worker fills install.sh when it serves it)
 *
 * Remove everything at any time:
 *   node ~/.sworm/agent.js --uninstall
 *
 * Build with install/build-binaries.sh. System libraries only: libc
 * and libcurl-as-a-process on macOS and linux, WinINet on Windows.
 * No bundled anything, so the binaries stay in the tens of KB.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <direct.h>   /* _mkdir */
#include <process.h>  /* _spawnl */
#include <stdint.h>   /* intptr_t */
#include <windows.h>  /* DWORD and friends, needed before wininet.h */
#include <wininet.h>  /* InternetOpenA, InternetOpenUrlA, InternetReadFile */
#else
#include <fcntl.h>    /* open */
#include <sys/stat.h> /* mkdir, chmod */
#include <sys/types.h>
#include <unistd.h>   /* fork, setsid, dup2, execlp */
#endif

/* Fill these three before distributing a binary, or leave them and set
 * the environment variables at run time. The worker serves pre-filled
 * installer scripts at /install and /install.ps1; this file is the
 * native equivalent. */
#define DEFAULT_WORKER_URL "__SWORM_WORKER_URL__"
#define DEFAULT_BOOTSTRAP_TOKEN "__SWORM_BOOTSTRAP_TOKEN__"
#define DEFAULT_AGENT_URL "__SWORM_AGENT_URL__"

static void die(const char *msg) {
  fprintf(stderr, "sworm-setup: error: %s\n", msg);
  exit(1);
}

static void step(const char *msg) {
  printf("sworm-setup: %s\n", msg);
  fflush(stdout);
}

/* An unset placeholder counts as empty. */
static const char *pick(const char *envName, const char *fallback) {
  const char *v = getenv(envName);
  if (v && *v && strncmp(v, "__SWORM_", 8) != 0) return v;
  if (fallback && *fallback && strncmp(fallback, "__SWORM_", 8) != 0)
    return fallback;
  return "";
}

static void usage(void) {
  printf(
      "sworm-setup: native installer for the sworm agent.\n"
      "\n"
      "usage: sworm-setup [--help]\n"
      "\n"
      "what it does:\n"
      "  1. checks for node.js 18 or newer\n"
      "  2. creates ~/.sworm\n"
      "  3. installs the agent at ~/.sworm/agent.js (copies the file from\n"
      "     SWORM_AGENT_FILE or ./agent.js when present, otherwise\n"
      "     downloads it from your worker)\n"
      "  4. writes ~/.sworm/config.json\n"
      "  5. starts the agent in the background\n"
      "\n"
      "configuration (environment variables win over compiled-in values):\n"
      "  SWORM_WORKER_URL       your worker url (required)\n"
      "  SWORM_BOOTSTRAP_TOKEN  enroll-only token from wrangler secret\n"
      "  SWORM_AGENT_URL        optional direct url for the agent source\n"
      "  SWORM_AGENT_FILE       optional local agent.js to copy instead\n"
      "\n"
      "the agent sets up its own persistence under visible names and the\n"
      "installer prints every step. remove everything with:\n"
      "  node ~/.sworm/agent.js --uninstall\n");
}

/* Returns the node major version, or -1 when node is missing. */
static int nodeMajor(void) {
  char buf[64];
  int major = -1;
  FILE *p;
#ifdef _WIN32
  p = _popen("node --version 2>NUL", "r");
#else
  p = popen("node --version 2>/dev/null", "r");
#endif
  if (!p) return -1;
  buf[0] = 0;
  if (fgets(buf, sizeof buf, p) && buf[0] == 'v') major = atoi(buf + 1);
#ifdef _WIN32
  _pclose(p);
#else
  pclose(p);
#endif
  return major;
}

static const char *homeDir(void) {
  const char *h = getenv("HOME");
#ifdef _WIN32
  if (!h || !*h) h = getenv("USERPROFILE");
#endif
  if (!h || !*h) die("could not find your home directory.");
  return h;
}

static int copyFile(const char *src, const char *dst) {
  char buf[16384];
  size_t n;
  FILE *in = fopen(src, "rb");
  if (!in) return -1;
  FILE *out = fopen(dst, "wb");
  if (!out) {
    fclose(in);
    return -1;
  }
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) {
    if (fwrite(buf, 1, n, out) != n) {
      fclose(in);
      fclose(out);
      return -1;
    }
  }
  fclose(in);
  fclose(out);
  return 0;
}

#ifdef _WIN32
/* HTTPS GET straight from WinINet, which ships with Windows. No curl,
 * no bundled TLS library. */
static int downloadFile(const char *url, const char *token,
                        const char *dst) {
  char hdrs[512];
  char buf[16384];
  DWORD got;
  DWORD status = 0;
  DWORD slen = sizeof status;
  int ok = -1;
  HINTERNET net =
      InternetOpenA("sworm-setup", INTERNET_OPEN_TYPE_PRECONFIG, NULL,
                    NULL, 0);
  if (!net) return -1;
  hdrs[0] = 0;
  if (token && *token)
    snprintf(hdrs, sizeof hdrs, "Authorization: Bearer %s\r\n", token);
  HINTERNET h = InternetOpenUrlA(
      net, url, hdrs, hdrs[0] ? -1L : 0,
      INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE |
          INTERNET_FLAG_SECURE,
      0);
  if (!h) {
    InternetCloseHandle(net);
    return -1;
  }
  HttpQueryInfoA(h, HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER,
                 &status, &slen, NULL);
  if (status == 200) {
    FILE *out = fopen(dst, "wb");
    if (out) {
      ok = 0;
      while (InternetReadFile(h, buf, sizeof buf, &got) && got > 0) {
        if (fwrite(buf, 1, got, out) != (size_t)got) {
          ok = -1;
          break;
        }
      }
      fclose(out);
    }
  }
  InternetCloseHandle(h);
  InternetCloseHandle(net);
  return ok;
}
#else
/* macOS and linux both ship curl. Spawning it keeps this program free
 * of TLS code and keeps the binary small. */
static int downloadFile(const char *url, const char *token,
                        const char *dst) {
  char cmd[2048];
  if (token && *token)
    snprintf(cmd, sizeof cmd,
             "curl -fsSL -H \"Authorization: Bearer %s\" \"%s\" -o \"%s\"",
             token, url, dst);
  else
    snprintf(cmd, sizeof cmd, "curl -fsSL \"%s\" -o \"%s\"", url, dst);
  return system(cmd) == 0 ? 0 : -1;
}
#endif

/* Start the agent detached so it keeps running after we exit. It shows
 * in the process list as node running the visible agent.js file. */
#ifdef _WIN32
static int startAgent(const char *agentPath) {
  intptr_t rc = _spawnl(_P_DETACH, "node", "node", agentPath, NULL);
  return rc == -1 ? -1 : 0;
}
#else
static int startAgent(const char *agentPath) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    int devnull;
    setsid();
    devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
      dup2(devnull, 0);
      dup2(devnull, 1);
      dup2(devnull, 2);
    }
    execlp("node", "node", agentPath, (char *)NULL);
    _exit(127);
  }
  return 0;
}
#endif

int main(int argc, char **argv) {
  const char *workerUrl;
  const char *token;
  const char *agentUrl;
  const char *agentFile;
  const char *home;
  char dir[1024];
  char agentPath[1200];
  char configPath[1200];
  char url[1600];
  int major;
  int i;
  FILE *f;

  for (i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      usage();
      return 0;
    }
    fprintf(stderr, "sworm-setup: unknown argument: %s (try --help)\n",
            argv[i]);
    return 2;
  }

  workerUrl = pick("SWORM_WORKER_URL", DEFAULT_WORKER_URL);
  token = pick("SWORM_BOOTSTRAP_TOKEN", DEFAULT_BOOTSTRAP_TOKEN);
  agentUrl = pick("SWORM_AGENT_URL", DEFAULT_AGENT_URL);
  agentFile = getenv("SWORM_AGENT_FILE");

  printf("sworm setup\n");
  if (!*workerUrl)
    die("no worker url configured. set SWORM_WORKER_URL or fill the "
        "placeholder at the top of sworm-setup.c.");
  printf("worker: %s\n", workerUrl);

  major = nodeMajor();
  if (major < 0)
    die("node.js is not installed. install node 18 or newer, then "
        "rerun this program.");
  if (major < 18) die("node 18 or newer is required.");

  home = homeDir();
  snprintf(dir, sizeof dir, "%s/.sworm", home);
  snprintf(agentPath, sizeof agentPath, "%s/agent.js", dir);
  snprintf(configPath, sizeof configPath, "%s/config.json", dir);

  step("creating ~/.sworm");
#ifdef _WIN32
  if (_mkdir(dir) != 0 && errno != EEXIST)
#else
  if (mkdir(dir, 0700) != 0 && errno != EEXIST)
#endif
    die("could not create the state dir.");

  if (agentFile && *agentFile) {
    step("copying the agent from SWORM_AGENT_FILE");
    if (copyFile(agentFile, agentPath) != 0)
      die("could not copy the agent file.");
  } else if ((f = fopen("agent.js", "rb")) != NULL) {
    fclose(f);
    step("copying ./agent.js from the current directory");
    if (copyFile("agent.js", agentPath) != 0)
      die("could not copy ./agent.js.");
  } else {
    int done = 0;
    if (*agentUrl) {
      step("downloading the agent");
      done = (downloadFile(agentUrl, NULL, agentPath) == 0);
      if (!done) step("direct download failed, trying the worker route");
    }
    if (!done) {
      if (!*token)
        die("no bootstrap token configured. set SWORM_BOOTSTRAP_TOKEN "
            "or fill the placeholder at the top of sworm-setup.c.");
      if (!*agentUrl) step("downloading the agent");
      snprintf(url, sizeof url, "%s/v1/agent", workerUrl);
      if (downloadFile(url, token, agentPath) != 0)
        die("could not download the agent.");
    }
  }
#ifndef _WIN32
  chmod(agentPath, 0755);
#endif

  step("writing config");
  f = fopen(configPath, "w");
  if (!f) die("could not write the config file.");
  fprintf(f, "{\n  \"workerUrl\": \"%s\",\n  \"bootstrapToken\": \"%s\"\n}\n",
          workerUrl, token);
  fclose(f);
#ifndef _WIN32
  chmod(configPath, 0600);
#endif

  step("starting the agent");
  if (startAgent(agentPath) != 0)
    die("could not start the agent.");

  printf("sworm agent installed\n");
  printf("state dir: %s\n", dir);
  printf("uninstall: node %s --uninstall\n", agentPath);
  return 0;
}
