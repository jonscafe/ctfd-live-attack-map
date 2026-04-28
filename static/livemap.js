(function () {
  if (window.__ctfdLiveMapLoaded) {
    return;
  }
  window.__ctfdLiveMapLoaded = true;

  const LIVEMAP_POLL_INTERVAL = 2000;
  const GLOBAL_POLL_INTERVAL = 4000;
  const TOP_NODE_COUNT = 10;
  const SOLVE_FEED_COUNT = 50;
  const TOAST_DURATION = 4500;
  const BEAM_LIMIT = 120;
  const TEAM_NODE_RADIUS = 14;
  const CHALLENGE_NODE_RADIUS = 11;
  const MIN_VIEW_SCALE = 0.7;
  const MAX_VIEW_SCALE = 2.6;

  function getUrlRoot() {
    return (window.init && window.init.urlRoot) || "";
  }

  function withRoot(path) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${getUrlRoot()}${normalized}`;
  }

  function getMode() {
    return window.init && window.init.userMode === "teams" ? "teams" : "users";
  }

  function getModeLabel() {
    return getMode() === "teams" ? "Teams" : "Users";
  }

  function getAccountType() {
    return getMode() === "teams" ? "team" : "user";
  }

  function isLiveMapPage() {
    const pathname = window.location && window.location.pathname;
    return pathname === withRoot("/livemap");
  }

  function getPollInterval() {
    return isLiveMapPage() ? LIVEMAP_POLL_INTERVAL : GLOBAL_POLL_INTERVAL;
  }

  function hashString(input) {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(index);
      hash |= 0;
    }
    return hash >>> 0;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function truncate(value, maxLength) {
    if (!value || value.length <= maxLength) {
      return value || "";
    }
    return `${value.slice(0, maxLength - 1)}…`;
  }

  function formatScore(value) {
    if (typeof value !== "number") {
      return "0";
    }
    return value.toLocaleString();
  }

  function parseDateValue(value) {
    const timestamp = Date.parse(value || "");
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  async function fetchJson(path) {
    const requestPath = path.startsWith("/") ? path : `/${path}`;
    const useCTFdFetch = window.CTFd && typeof window.CTFd.fetch === "function";
    const targetPath = useCTFdFetch ? requestPath : withRoot(requestPath);
    const fetcher = useCTFdFetch
      ? window.CTFd.fetch.bind(window.CTFd)
      : window.fetch.bind(window);
    const response = await fetcher(targetPath, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const error = new Error(`Request failed for ${requestPath} (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const error = new Error(`Expected JSON from ${requestPath}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  const toastManager = {
    element: null,
    teamElement: null,
    challengeElement: null,
    hideTimer: null,
    audio: null,

    ensureToast() {
      if (!this.element) {
        this.element = document.getElementById("livemap-firstblood-toast");
      }
      if (!this.element) {
        const root = document.createElement("div");
        root.id = "livemap-firstblood-toast";
        root.className = "livemap-firstblood-toast";
        root.setAttribute("aria-live", "assertive");
        root.setAttribute("aria-atomic", "true");
        root.innerHTML = [
          '<div class="livemap-fb-icon"><i class="fas fa-skull-crossbones" aria-hidden="true"></i></div>',
          '<div class="livemap-fb-title">FIRST BLOOD!</div>',
          '<p class="livemap-fb-detail">',
          '  <span id="livemap-firstblood-team" class="livemap-fb-team">Unknown</span>',
          "  pwned",
          '  <span id="livemap-firstblood-challenge" class="livemap-fb-challenge">Unknown</span>',
          "</p>",
        ].join("");
        document.body.appendChild(root);
        this.element = root;
      }
      this.teamElement = document.getElementById("livemap-firstblood-team");
      this.challengeElement = document.getElementById("livemap-firstblood-challenge");
    },

    ensureAudio() {
      if (!this.audio) {
        this.audio = new Audio(withRoot("/plugins/live-attack-map/static/sounds/firstblood.mp3"));
        this.audio.preload = "auto";
      }
      return this.audio;
    },

    show(teamName, challengeName) {
      this.ensureToast();
      if (!this.element || !this.teamElement || !this.challengeElement) {
        return;
      }

      this.teamElement.textContent = teamName || "Unknown";
      this.challengeElement.textContent = challengeName || "Unknown";
      this.element.classList.add("is-visible");

      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
      }
      this.hideTimer = window.setTimeout(() => {
        if (this.element) {
          this.element.classList.remove("is-visible");
        }
      }, TOAST_DURATION);

      const audio = this.ensureAudio();
      try {
        audio.currentTime = 0;
        const promise = audio.play();
        if (promise && typeof promise.catch === "function") {
          promise.catch(() => {});
        }
      } catch (error) {
        // Browser autoplay policies can block this. Silent fail is acceptable.
      }
    },
  };

  const liveMapStore = {
    subscribers: new Set(),
    fetching: false,
    pollHandle: null,
    confirmCache: new Map(),
    state: {
      mapStatus: "Loading",
      mapStatusTone: "idle",
      stats: {
        teams: 0,
        challs: 0,
        solves: 0,
        mode: getModeLabel(),
      },
      topTeams: [],
      challenges: [],
      firstBloods: {},
      lastPollAt: null,
    },
    solveKeys: new Set(),
    challengeSolveCounts: {},
    initialized: false,

    snapshot() {
      return {
        mapStatus: this.state.mapStatus,
        mapStatusTone: this.state.mapStatusTone,
        stats: { ...this.state.stats },
        topTeams: this.state.topTeams.map(team => ({ ...team })),
        challenges: this.state.challenges.map(challenge => ({ ...challenge })),
        firstBloods: { ...this.state.firstBloods },
        lastPollAt: this.state.lastPollAt,
      };
    },

    subscribe(listener) {
      this.subscribers.add(listener);
      listener({ snapshot: this.snapshot(), newEvents: [] });
      return () => {
        this.subscribers.delete(listener);
      };
    },

    notify(newEvents) {
      const payload = {
        snapshot: this.snapshot(),
        newEvents: newEvents || [],
      };
      this.subscribers.forEach(listener => listener(payload));
    },

    start() {
      if (this.pollHandle) {
        return;
      }
      this.poll();
      this.pollHandle = window.setInterval(() => this.poll(), getPollInterval());
    },

    async confirmFirstSolve(challengeId) {
      if (this.confirmCache.has(challengeId)) {
        return this.confirmCache.get(challengeId);
      }

      const promise = fetchJson(`/api/v1/challenges/${challengeId}/solves`)
        .then(response => {
          const solves = Array.isArray(response && response.data) ? response.data : [];
          return solves.length ? solves[0] : null;
        })
        .catch(() => null);

      this.confirmCache.set(challengeId, promise);
      return promise;
    },

    normalizeStandings(response) {
      const accounts = Array.isArray(response && response.data) ? response.data : [];
      return accounts.slice(0, TOP_NODE_COUNT).map((account, index) => {
        const accountId = account.account_id != null ? account.account_id : account.id;
        const accountType = account.account_type || getAccountType();
        return {
          key: `${accountType}:${accountId}`,
          accountId,
          accountType,
          name: account.name || "Unknown",
          score: Number(account.score || 0),
          rank: Number(account.pos || index + 1),
        };
      });
    },

    normalizeChallenges(response) {
      const challenges = Array.isArray(response && response.data) ? response.data : [];
      return challenges.map(challenge => ({
        id: Number(challenge.id),
        name: challenge.name || "Unknown",
        solves: typeof challenge.solves === "number" ? challenge.solves : 0,
      }));
    },

    normalizeSolveFeed(response) {
      const payload = response && response.data;
      const accounts = Array.isArray(payload) ? payload : Object.values(payload || {});
      const accountType = getAccountType();
      return accounts.map(account => {
        const accountId = account.account_id != null ? account.account_id : account.id;
        return {
          key: `${accountType}:${accountId}`,
          accountId,
          accountType,
          name: account.name || "Unknown",
          solves: Array.isArray(account.solves) ? account.solves : [],
        };
      });
    },

    buildFallbackChallenges(solveFeed) {
      const knownChallenges = this.state.challenges.reduce((lookup, challenge) => {
        lookup[challenge.id] = challenge;
        return lookup;
      }, {});
      const challengeIds = new Set();

      solveFeed.forEach(account => {
        account.solves.forEach(solve => {
          if (solve && solve.challenge_id != null) {
            challengeIds.add(Number(solve.challenge_id));
          }
        });
      });

      return Array.from(challengeIds)
        .sort((left, right) => left - right)
        .map(challengeId => {
          const existing = knownChallenges[challengeId];
          return {
            id: challengeId,
            name: existing ? existing.name : `Challenge #${challengeId}`,
            solves: existing ? existing.solves : this.challengeSolveCounts[challengeId] || 0,
          };
        });
    },

    buildSolveKey(account, solve) {
      return [
        account.accountType,
        account.accountId,
        solve.challenge_id,
        solve.date,
      ].join(":");
    },

    async poll() {
      if (this.fetching) {
        return;
      }
      this.fetching = true;

      try {
        const [standingsResult, challengesResult, solveFeedResult] = await Promise.allSettled([
          fetchJson("/api/v1/scoreboard"),
          fetchJson("/api/v1/challenges"),
          fetchJson(`/api/v1/scoreboard/top/${SOLVE_FEED_COUNT}`),
        ]);

        const standingsResponse = standingsResult.status === "fulfilled" ? standingsResult.value : null;
        const challengesResponse = challengesResult.status === "fulfilled" ? challengesResult.value : null;
        const solveFeedResponse = solveFeedResult.status === "fulfilled" ? solveFeedResult.value : null;

        if (!standingsResponse && !solveFeedResponse && !challengesResponse) {
          throw new Error("Live map polling failed for all data sources");
        }

        const topTeams = standingsResponse
          ? this.normalizeStandings(standingsResponse)
          : this.state.topTeams.slice();
        const solveFeed = solveFeedResponse ? this.normalizeSolveFeed(solveFeedResponse) : [];
        const challenges = challengesResponse
          ? this.normalizeChallenges(challengesResponse)
          : this.buildFallbackChallenges(solveFeed);

        const challengeSolveCounts = {};
        let totalSolveCount = 0;
        challenges.forEach(challenge => {
          challengeSolveCounts[challenge.id] = challenge.solves;
          totalSolveCount += challenge.solves;
        });

        if (!challengesResponse) {
          totalSolveCount = solveFeed.reduce((count, account) => {
            return count + account.solves.filter(solve => solve && solve.challenge_id != null).length;
          }, 0);
        }

        const newEvents = [];
        solveFeed.forEach(account => {
          account.solves.forEach(solve => {
            if (!solve || solve.challenge_id == null) {
              return;
            }
            const key = this.buildSolveKey(account, solve);
            if (this.solveKeys.has(key)) {
              return;
            }
            this.solveKeys.add(key);
            newEvents.push({
              key,
              accountKey: account.key,
              accountId: account.accountId,
              accountType: account.accountType,
              teamName: account.name,
              challengeId: Number(solve.challenge_id),
              date: solve.date,
              value: Number(solve.value || 0),
              isFirstBlood: false,
            });
          });
        });

        this.state.topTeams = topTeams;
        this.state.challenges = challenges;
        this.state.stats = {
          teams: topTeams.length,
          challs: challenges.length,
          solves: totalSolveCount,
          mode: getModeLabel(),
        };
        this.state.lastPollAt = Date.now();

        if (!this.initialized) {
          this.initialized = true;
          this.challengeSolveCounts = challengeSolveCounts;
          this.state.mapStatus = topTeams.length ? "Live" : "Waiting for scores";
          this.state.mapStatusTone = topTeams.length ? "live" : "idle";
          this.notify([]);
          return;
        }

        const grouped = new Map();
        newEvents.forEach(event => {
          if (!grouped.has(event.challengeId)) {
            grouped.set(event.challengeId, []);
          }
          grouped.get(event.challengeId).push(event);
        });

        const challengeLookup = challenges.reduce((lookup, challenge) => {
          lookup[challenge.id] = challenge;
          return lookup;
        }, {});

        for (const [challengeId, events] of grouped.entries()) {
          events.sort((left, right) => parseDateValue(left.date) - parseDateValue(right.date));
          const previousSolveCount = this.challengeSolveCounts[challengeId] || 0;
          const currentSolveCount = challengeSolveCounts[challengeId] || 0;

          if (!(challengeId in this.state.firstBloods) && currentSolveCount > 0 && challengesResponse) {
            const confirmedFirstSolve = await this.confirmFirstSolve(challengeId);
            if (confirmedFirstSolve) {
              this.state.firstBloods[challengeId] = {
                accountId: confirmedFirstSolve.account_id,
                name: confirmedFirstSolve.name || "",
                date: confirmedFirstSolve.date,
              };
              const matchedEvent = events.find(event => {
                return (
                  String(event.accountId) === String(confirmedFirstSolve.account_id) &&
                  event.date === confirmedFirstSolve.date
                );
              });
              if (matchedEvent && previousSolveCount === 0) {
                matchedEvent.isFirstBlood = true;
                const challenge = challengeLookup[challengeId];
                toastManager.show(matchedEvent.teamName, challenge ? challenge.name : "Unknown");
              }
            }
          }
        }

        this.challengeSolveCounts = challengeSolveCounts;

        if (!topTeams.length) {
          this.state.mapStatus = "Waiting for scores";
          this.state.mapStatusTone = "idle";
        } else if (newEvents.length) {
          this.state.mapStatus = "Live";
          this.state.mapStatusTone = "live";
        } else {
          this.state.mapStatus = "Waiting for solves";
          this.state.mapStatusTone = "idle";
        }

        this.notify(newEvents);
      } catch (error) {
        this.state.mapStatus = "Paused";
        this.state.mapStatusTone = "warn";
        this.notify([]);
      } finally {
        this.fetching = false;
      }
    },
  };

  function createLiveMapComponent() {
    return {
      mapStatus: "Loading",
      mapStatusTone: "idle",
      stats: {
        teams: 0,
        challs: 0,
        solves: 0,
        mode: getModeLabel(),
      },
      lastPollLabel: "Never",
      zoomLabel: "100%",
      canvas: null,
      ctx: null,
      dpr: 1,
      width: 0,
      height: 0,
      viewScale: 1,
      viewOffsetX: 0,
      viewOffsetY: 0,
      hasInteracted: false,
      viewInitialized: false,
      isDragging: false,
      dragPointerId: null,
      dragLastX: 0,
      dragLastY: 0,
      topTeams: [],
      challenges: [],
      firstBloods: {},
      teamNodes: {},
      challNodes: {},
      beams: [],
      _unsubscribe: null,
      _resizeHandler: null,
      _frameHandle: null,
      _pointerDownHandler: null,
      _pointerMoveHandler: null,
      _pointerUpHandler: null,
      _pointerCancelHandler: null,
      _wheelHandler: null,

      init() {
        document.body.classList.add("livemap-mode");
        if (this.$el) {
          this.$el.dataset.livemapMounted = "true";
        }
        this.canvas = this.$refs.mapCanvas;
        this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
        this.updateZoomLabel();
        this.bindCanvasInteractions();
        this._resizeHandler = () => this.resize();
        window.addEventListener("resize", this._resizeHandler);
        this.resize();

        this._unsubscribe = liveMapStore.subscribe(payload => {
          this.applySnapshot(payload.snapshot);
          this.ingestEvents(payload.newEvents);
        });

        this.loop();
        liveMapStore.start();
      },

      destroy() {
        document.body.classList.remove("livemap-mode");
        if (this._unsubscribe) {
          this._unsubscribe();
        }
        if (this._resizeHandler) {
          window.removeEventListener("resize", this._resizeHandler);
        }
        if (this._frameHandle) {
          window.cancelAnimationFrame(this._frameHandle);
        }
        this.unbindCanvasInteractions();
      },

      bindCanvasInteractions() {
        if (!this.canvas) {
          return;
        }
        this._pointerDownHandler = event => this.onPointerDown(event);
        this._pointerMoveHandler = event => this.onPointerMove(event);
        this._pointerUpHandler = event => this.onPointerUp(event);
        this._pointerCancelHandler = event => this.onPointerUp(event);
        this._wheelHandler = event => this.onWheel(event);

        this.canvas.addEventListener("pointerdown", this._pointerDownHandler);
        this.canvas.addEventListener("pointermove", this._pointerMoveHandler);
        this.canvas.addEventListener("pointerup", this._pointerUpHandler);
        this.canvas.addEventListener("pointercancel", this._pointerCancelHandler);
        this.canvas.addEventListener("wheel", this._wheelHandler, { passive: false });
      },

      unbindCanvasInteractions() {
        if (!this.canvas) {
          return;
        }
        if (this._pointerDownHandler) {
          this.canvas.removeEventListener("pointerdown", this._pointerDownHandler);
        }
        if (this._pointerMoveHandler) {
          this.canvas.removeEventListener("pointermove", this._pointerMoveHandler);
        }
        if (this._pointerUpHandler) {
          this.canvas.removeEventListener("pointerup", this._pointerUpHandler);
        }
        if (this._pointerCancelHandler) {
          this.canvas.removeEventListener("pointercancel", this._pointerCancelHandler);
        }
        if (this._wheelHandler) {
          this.canvas.removeEventListener("wheel", this._wheelHandler);
        }
      },

      onPointerDown(event) {
        if (!this.canvas) {
          return;
        }
        if (event.pointerType !== "touch" && event.button !== 0) {
          return;
        }
        event.preventDefault();
        this.isDragging = true;
        this.dragPointerId = event.pointerId;
        this.dragLastX = event.clientX;
        this.dragLastY = event.clientY;
        this.canvas.classList.add("is-dragging");
        if (typeof this.canvas.setPointerCapture === "function") {
          try {
            this.canvas.setPointerCapture(event.pointerId);
          } catch (error) {
            // Pointer capture can fail in some embedded browsers. Drag still works without it.
          }
        }
      },

      onPointerMove(event) {
        if (!this.isDragging || event.pointerId !== this.dragPointerId) {
          return;
        }
        event.preventDefault();
        this.hasInteracted = true;
        this.viewOffsetX += event.clientX - this.dragLastX;
        this.viewOffsetY += event.clientY - this.dragLastY;
        this.dragLastX = event.clientX;
        this.dragLastY = event.clientY;
        this.clampViewport();
      },

      onPointerUp(event) {
        if (!this.isDragging || event.pointerId !== this.dragPointerId) {
          return;
        }
        this.isDragging = false;
        this.dragPointerId = null;
        if (this.canvas) {
          this.canvas.classList.remove("is-dragging");
          if (typeof this.canvas.releasePointerCapture === "function") {
            try {
              this.canvas.releasePointerCapture(event.pointerId);
            } catch (error) {
              // Safe to ignore when pointer capture was never established.
            }
          }
        }
      },

      onWheel(event) {
        if (!this.canvas) {
          return;
        }
        event.preventDefault();
        const bounds = this.canvas.getBoundingClientRect();
        const originX = event.clientX - bounds.left;
        const originY = event.clientY - bounds.top;

        if (event.ctrlKey || event.metaKey) {
          const zoomFactor = Math.exp(-event.deltaY * 0.0015);
          this.zoomAt(originX, originY, this.viewScale * zoomFactor);
          return;
        }

        this.hasInteracted = true;
        if (event.shiftKey && Math.abs(event.deltaX) < 0.5) {
          this.viewOffsetX -= event.deltaY;
        } else {
          this.viewOffsetX -= event.deltaX;
          this.viewOffsetY -= event.deltaY;
        }
        this.clampViewport();
      },

      zoomAt(originX, originY, nextScale) {
        const clampedScale = clamp(nextScale, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
        if (Math.abs(clampedScale - this.viewScale) < 0.001) {
          return;
        }

        const worldX = (originX - this.viewOffsetX) / this.viewScale;
        const worldY = (originY - this.viewOffsetY) / this.viewScale;

        this.viewScale = clampedScale;
        this.viewOffsetX = originX - worldX * this.viewScale;
        this.viewOffsetY = originY - worldY * this.viewScale;
        this.hasInteracted = true;
        this.clampViewport();
        this.updateZoomLabel();
      },

      zoomIn() {
        this.zoomAt(this.width / 2, this.height / 2, this.viewScale * 1.18);
      },

      zoomOut() {
        this.zoomAt(this.width / 2, this.height / 2, this.viewScale / 1.18);
      },

      resetView() {
        const contentBounds = this.getContentBounds();
        this.viewScale = 1;
        this.viewOffsetX = this.width / 2 - ((contentBounds.minX + contentBounds.maxX) / 2) * this.viewScale;
        this.viewOffsetY = this.height / 2 - ((contentBounds.minY + contentBounds.maxY) / 2) * this.viewScale;
        this.hasInteracted = false;
        this.viewInitialized = true;
        this.clampViewport();
        this.updateZoomLabel();
      },

      updateZoomLabel() {
        this.zoomLabel = `${Math.round(this.viewScale * 100)}%`;
      },

      applySnapshot(snapshot) {
        this.mapStatus = snapshot.mapStatus;
        this.mapStatusTone = snapshot.mapStatusTone;
        this.stats = snapshot.stats;
        this.topTeams = snapshot.topTeams;
        this.challenges = snapshot.challenges;
        this.firstBloods = snapshot.firstBloods;
        this.lastPollLabel = snapshot.lastPollAt
          ? new Date(snapshot.lastPollAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "Never";
        this.layoutNodes();
      },

      ingestEvents(events) {
        if (!Array.isArray(events) || !events.length) {
          return;
        }
        const visibleAccounts = new Set(this.topTeams.map(team => team.key));
        events.forEach(event => {
          if (!visibleAccounts.has(event.accountKey)) {
            return;
          }
          if (!this.challNodes[event.challengeId]) {
            return;
          }
          this.beams.push({
            accountKey: event.accountKey,
            challengeId: event.challengeId,
            start: performance.now(),
            duration: 2200 + Math.random() * 400,
            isFirstBlood: Boolean(event.isFirstBlood),
          });
        });
        if (this.beams.length > BEAM_LIMIT) {
          this.beams = this.beams.slice(-BEAM_LIMIT);
        }
      },

      resize() {
        if (!this.canvas || !this.ctx) {
          return;
        }
        const container = this.$refs.mapWrap;
        if (!container) {
          return;
        }
        const bounds = container.getBoundingClientRect();
        this.width = Math.max(320, Math.floor(bounds.width));
        this.height = Math.max(420, Math.floor(bounds.height));
        this.dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.floor(this.width * this.dpr);
        this.canvas.height = Math.floor(this.height * this.dpr);
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.layoutNodes();
      },

      layoutNodes() {
        if (!this.width || !this.height) {
          return;
        }

        const contentTop = 48;
        const contentBottom = this.height - 54;
        const contentHeight = Math.max(80, contentBottom - contentTop);

        const teamX = clamp(this.width * 0.18, 120, 220);
        const rightEdge = this.width - clamp(this.width * 0.12, 92, 170);

        const nextTeamNodes = {};
        const teamStep = this.topTeams.length > 1
          ? contentHeight / (this.topTeams.length - 1)
          : 0;

        this.topTeams.forEach((team, index) => {
          const existing = this.teamNodes[team.key];
          nextTeamNodes[team.key] = {
            key: team.key,
            name: team.name,
            rank: team.rank,
            score: team.score,
            x: existing ? existing.x : teamX,
            y: existing ? existing.y : contentTop + teamStep * index,
            targetX: teamX,
            targetY: contentTop + teamStep * index,
          };
        });

        const nextChallNodes = {};
        const maxRows = Math.max(8, Math.floor(contentHeight / 48));
        const columnCount = Math.max(1, Math.ceil(this.challenges.length / maxRows));
        const columnGap = 72;

        this.challenges.forEach((challenge, index) => {
          const column = Math.floor(index / maxRows);
          const row = index % maxRows;
          const rowsInColumn = Math.min(maxRows, this.challenges.length - column * maxRows);
          const rowStep = rowsInColumn > 1
            ? contentHeight / (rowsInColumn - 1)
            : 0;
          const x = rightEdge - (columnCount - column - 1) * columnGap;
          const y = contentTop + row * rowStep;
          const existing = this.challNodes[challenge.id];
          nextChallNodes[challenge.id] = {
            id: challenge.id,
            name: challenge.name,
            x: existing ? existing.x : x,
            y: existing ? existing.y : y,
            targetX: x,
            targetY: y,
          };
        });

        this.teamNodes = nextTeamNodes;
        this.challNodes = nextChallNodes;

        if (!this.viewInitialized || !this.hasInteracted) {
          this.resetView();
        } else {
          this.clampViewport();
        }
      },

      getContentBounds() {
        const bounds = {
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
        };

        const includePoint = (x, y) => {
          bounds.minX = Math.min(bounds.minX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.maxY = Math.max(bounds.maxY, y);
        };

        Object.values(this.teamNodes).forEach(node => {
          const x = typeof node.targetX === "number" ? node.targetX : node.x;
          const y = typeof node.targetY === "number" ? node.targetY : node.y;
          includePoint(x - 48, y - 42);
          includePoint(x + 220, y + 34);
        });

        Object.values(this.challNodes).forEach(node => {
          const x = typeof node.targetX === "number" ? node.targetX : node.x;
          const y = typeof node.targetY === "number" ? node.targetY : node.y;
          includePoint(x - 280, y - 28);
          includePoint(x + 28, y + 28);
        });

        if (!Number.isFinite(bounds.minX)) {
          return {
            minX: 0,
            minY: 0,
            maxX: this.width,
            maxY: this.height,
          };
        }

        return bounds;
      },

      getVisibleWorldBounds() {
        return {
          minX: (-this.viewOffsetX) / this.viewScale,
          minY: (-this.viewOffsetY) / this.viewScale,
          maxX: (this.width - this.viewOffsetX) / this.viewScale,
          maxY: (this.height - this.viewOffsetY) / this.viewScale,
        };
      },

      clampViewport() {
        if (!this.width || !this.height || !this.viewScale) {
          return;
        }

        const bounds = this.getContentBounds();
        const paddingX = Math.min(140, this.width * 0.16);
        const paddingY = Math.min(110, this.height * 0.16);
        const minOffsetX = paddingX - bounds.maxX * this.viewScale;
        const maxOffsetX = this.width - paddingX - bounds.minX * this.viewScale;
        const minOffsetY = paddingY - bounds.maxY * this.viewScale;
        const maxOffsetY = this.height - paddingY - bounds.minY * this.viewScale;

        if (minOffsetX > maxOffsetX) {
          this.viewOffsetX = (minOffsetX + maxOffsetX) / 2;
        } else {
          this.viewOffsetX = clamp(this.viewOffsetX, minOffsetX, maxOffsetX);
        }

        if (minOffsetY > maxOffsetY) {
          this.viewOffsetY = (minOffsetY + maxOffsetY) / 2;
        } else {
          this.viewOffsetY = clamp(this.viewOffsetY, minOffsetY, maxOffsetY);
        }
      },

      animateNodePositions() {
        Object.values(this.teamNodes).forEach(node => {
          node.x += (node.targetX - node.x) * 0.12;
          node.y += (node.targetY - node.y) * 0.12;
        });
        Object.values(this.challNodes).forEach(node => {
          node.x += (node.targetX - node.x) * 0.12;
          node.y += (node.targetY - node.y) * 0.12;
        });
      },

      drawBackground() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        const background = ctx.createLinearGradient(0, 0, this.width, this.height);
        background.addColorStop(0, "#050508");
        background.addColorStop(1, "#09111b");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, this.width, this.height);

        const flare = ctx.createRadialGradient(this.width * 0.72, this.height * 0.34, 40, this.width * 0.72, this.height * 0.34, this.width * 0.66);
        flare.addColorStop(0, "rgba(255, 107, 0, 0.10)");
        flare.addColorStop(1, "rgba(255, 107, 0, 0)");
        ctx.fillStyle = flare;
        ctx.fillRect(0, 0, this.width, this.height);
      },

      drawWorldGrid() {
        const ctx = this.ctx;
        const visibleBounds = this.getVisibleWorldBounds();
        const startX = Math.floor((visibleBounds.minX - 96) / 64) * 64;
        const endX = Math.ceil((visibleBounds.maxX + 96) / 64) * 64;
        const startY = Math.floor((visibleBounds.minY - 96) / 52) * 52;
        const endY = Math.ceil((visibleBounds.maxY + 96) / 52) * 52;

        ctx.save();
        ctx.strokeStyle = "rgba(255, 107, 0, 0.08)";
        ctx.lineWidth = 1 / this.viewScale;
        for (let x = startX; x <= endX; x += 64) {
          ctx.beginPath();
          ctx.moveTo(x, startY);
          ctx.lineTo(x, endY);
          ctx.stroke();
        }
        for (let y = startY; y <= endY; y += 52) {
          ctx.beginPath();
          ctx.moveTo(startX, y);
          ctx.lineTo(endX, y);
          ctx.stroke();
        }
        ctx.restore();
      },

      drawAmbientConnections() {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
        ctx.lineWidth = 1;
        Object.values(this.teamNodes).forEach(node => {
          ctx.beginPath();
          ctx.moveTo(node.x + TEAM_NODE_RADIUS + 10, node.y);
          ctx.lineTo(this.width * 0.54, node.y);
          ctx.stroke();
        });
        ctx.restore();
      },

      drawTeamNodes() {
        const ctx = this.ctx;
        Object.values(this.teamNodes).forEach(node => {
          ctx.save();
          ctx.shadowColor = "rgba(0, 212, 255, 0.55)";
          ctx.shadowBlur = 18;
          ctx.fillStyle = "#00d4ff";
          ctx.beginPath();
          ctx.arc(node.x, node.y, TEAM_NODE_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          ctx.save();
          ctx.fillStyle = "rgba(6, 12, 18, 0.92)";
          ctx.strokeStyle = "rgba(0, 212, 255, 0.5)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(node.x - 26, node.y - 20, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#eef7ff";
          ctx.font = '700 11px "Share Tech Mono", monospace';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(node.rank), node.x - 26, node.y - 20);
          ctx.restore();

          ctx.save();
          ctx.fillStyle = "#eef7ff";
          ctx.font = '700 13px "Share Tech Mono", monospace';
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(truncate(node.name, 22), node.x + 24, node.y - 6);
          ctx.fillStyle = "rgba(238, 247, 255, 0.72)";
          ctx.font = '600 11px "Share Tech Mono", monospace';
          ctx.fillText(`${formatScore(node.score)} pts`, node.x + 24, node.y + 12);
          ctx.restore();
        });
      },

      drawChallengeNodes() {
        const ctx = this.ctx;
        Object.values(this.challNodes).forEach(node => {
          ctx.save();
          ctx.translate(node.x, node.y);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = "#ff003c";
          ctx.shadowColor = "rgba(255, 0, 60, 0.55)";
          ctx.shadowBlur = 18;
          ctx.fillRect(-CHALLENGE_NODE_RADIUS, -CHALLENGE_NODE_RADIUS, CHALLENGE_NODE_RADIUS * 2, CHALLENGE_NODE_RADIUS * 2);
          ctx.restore();

          if (this.firstBloods[node.id]) {
            ctx.save();
            ctx.fillStyle = "#ffd700";
            ctx.beginPath();
            ctx.arc(node.x + 13, node.y - 13, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }

          ctx.save();
          ctx.fillStyle = "#ffd9e2";
          ctx.font = '700 12px "Share Tech Mono", monospace';
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(truncate(node.name, 26), node.x - 18, node.y);
          ctx.restore();
        });
      },

      drawBeams(now) {
        const ctx = this.ctx;
        const active = [];

        this.beams.forEach(beam => {
          const fromNode = this.teamNodes[beam.accountKey];
          const toNode = this.challNodes[beam.challengeId];
          if (!fromNode || !toNode) {
            return;
          }

          const progress = clamp((now - beam.start) / beam.duration, 0, 1);
          if (progress >= 1) {
            return;
          }

          const fade = progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1;
          const color = beam.isFirstBlood ? "255, 215, 0" : "255, 107, 0";
          const pulseX = fromNode.x + (toNode.x - fromNode.x) * progress;
          const pulseY = fromNode.y + (toNode.y - fromNode.y) * progress;

          ctx.save();
          ctx.strokeStyle = `rgba(${color}, ${beam.isFirstBlood ? 0.36 : 0.22 * fade})`;
          ctx.lineWidth = beam.isFirstBlood ? 12 : 8;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(fromNode.x, fromNode.y);
          ctx.lineTo(toNode.x, toNode.y);
          ctx.stroke();
          ctx.restore();

          ctx.save();
          ctx.strokeStyle = `rgba(${color}, ${beam.isFirstBlood ? 0.95 : 0.8 * fade})`;
          ctx.lineWidth = beam.isFirstBlood ? 3.8 : 2.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(fromNode.x, fromNode.y);
          ctx.lineTo(toNode.x, toNode.y);
          ctx.stroke();
          ctx.restore();

          ctx.save();
          ctx.fillStyle = `rgba(${color}, 0.95)`;
          ctx.shadowColor = `rgba(${color}, 0.88)`;
          ctx.shadowBlur = beam.isFirstBlood ? 22 : 16;
          ctx.beginPath();
          ctx.arc(pulseX, pulseY, beam.isFirstBlood ? 7 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          if (progress > 0.6) {
            const ringProgress = (progress - 0.6) / 0.4;
            ctx.save();
            ctx.strokeStyle = `rgba(${color}, ${0.8 * (1 - ringProgress)})`;
            ctx.lineWidth = beam.isFirstBlood ? 3 : 2;
            ctx.beginPath();
            ctx.arc(toNode.x, toNode.y, 8 + ringProgress * 30, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          active.push(beam);
        });

        this.beams = active;
      },

      draw(now) {
        if (!this.ctx) {
          return;
        }
        this.animateNodePositions();
        this.drawBackground();
        this.ctx.save();
        this.ctx.translate(this.viewOffsetX, this.viewOffsetY);
        this.ctx.scale(this.viewScale, this.viewScale);
        this.drawWorldGrid();
        this.drawAmbientConnections();
        this.drawBeams(now);
        this.drawTeamNodes();
        this.drawChallengeNodes();
        this.ctx.restore();
      },

      loop() {
        this.draw(performance.now());
        this._frameHandle = window.requestAnimationFrame(() => this.loop());
      },
    };
  }

  function registerLiveMapComponent() {
    const mountRoots = () => {
      if (!window.Alpine || typeof window.Alpine.initTree !== "function") {
        return;
      }
      const roots = document.querySelectorAll('[x-data="LiveMap"]');
      roots.forEach(root => {
        if (root.dataset.livemapMounted === "true") {
          return;
        }
        try {
          window.Alpine.initTree(root);
        } catch (error) {
          // Late Alpine registration can race theme startup. A follow-up retry is fine.
        }
      });
    };

    const register = () => {
      if (!window.Alpine || window.Alpine.__ctfdLiveMapRegistered) {
        return;
      }
      window.Alpine.data("LiveMap", createLiveMapComponent);
      window.Alpine.__ctfdLiveMapRegistered = true;
      mountRoots();
      window.setTimeout(mountRoots, 0);
      window.setTimeout(mountRoots, 75);
    };

    if (window.Alpine) {
      register();
    }
    document.addEventListener("alpine:init", register);
    document.addEventListener("DOMContentLoaded", mountRoots);
  }

  registerLiveMapComponent();
  liveMapStore.start();
})();
