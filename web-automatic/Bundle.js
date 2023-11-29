(() => {
  // scripts/api.js
  var ComfyApi = class extends EventTarget {
    #registered = /* @__PURE__ */ new Set();
    constructor() {
      super();
      this.api_host = location.host;
      this.api_base = location.pathname.split("/").slice(0, -1).join("/");
    }
    apiURL(route) {
      return this.api_base + route;
    }
    fetchApi(route, options) {
      return fetch(this.apiURL(route), options);
    }
    addEventListener(type, callback, options) {
      super.addEventListener(type, callback, options);
      this.#registered.add(type);
    }
    /**
     * Poll status  for colab and other things that don't support websockets.
     */
    #pollQueue() {
      setInterval(async () => {
        try {
          const resp = await this.fetchApi("/prompt");
          const status = await resp.json();
          this.dispatchEvent(new CustomEvent("status", { detail: status }));
        } catch (error) {
          this.dispatchEvent(new CustomEvent("status", { detail: null }));
        }
      }, 1e3);
    }
    /**
     * Creates and connects a WebSocket for realtime updates
     * @param {boolean} isReconnect If the socket is connection is a reconnect attempt
     */
    #createSocket(isReconnect) {
      if (this.socket) {
        return;
      }
      let opened = false;
      let existingSession = window.name;
      if (existingSession) {
        existingSession = "?clientId=" + existingSession;
      }
      this.socket = new WebSocket(
        `ws${window.location.protocol === "https:" ? "s" : ""}://${this.api_host}${this.api_base}/ws${existingSession}`
      );
      this.socket.binaryType = "arraybuffer";
      this.socket.addEventListener("open", () => {
        opened = true;
        if (isReconnect) {
          this.dispatchEvent(new CustomEvent("reconnected"));
        }
      });
      this.socket.addEventListener("error", () => {
        if (this.socket)
          this.socket.close();
        if (!isReconnect && !opened) {
          this.#pollQueue();
        }
      });
      this.socket.addEventListener("close", () => {
        setTimeout(() => {
          this.socket = null;
          this.#createSocket(true);
        }, 300);
        if (opened) {
          this.dispatchEvent(new CustomEvent("status", { detail: null }));
          this.dispatchEvent(new CustomEvent("reconnecting"));
        }
      });
      this.socket.addEventListener("message", (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data);
            const eventType = view.getUint32(0);
            const buffer = event.data.slice(4);
            switch (eventType) {
              case 1:
                const view2 = new DataView(event.data);
                const imageType = view2.getUint32(0);
                let imageMime;
                switch (imageType) {
                  case 1:
                  default:
                    imageMime = "image/jpeg";
                    break;
                  case 2:
                    imageMime = "image/png";
                }
                const imageBlob = new Blob([buffer.slice(4)], { type: imageMime });
                this.dispatchEvent(new CustomEvent("b_preview", { detail: imageBlob }));
                break;
              default:
                throw new Error(`Unknown binary websocket message of type ${eventType}`);
            }
          } else {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case "status":
                if (msg.data.sid) {
                  this.clientId = msg.data.sid;
                  window.name = this.clientId;
                }
                this.dispatchEvent(new CustomEvent("status", { detail: msg.data.status }));
                break;
              case "progress":
                this.dispatchEvent(new CustomEvent("progress", { detail: msg.data }));
                break;
              case "executing":
                this.dispatchEvent(new CustomEvent("executing", { detail: msg.data.node }));
                break;
              case "executed":
                this.dispatchEvent(new CustomEvent("executed", { detail: msg.data }));
                break;
              case "execution_start":
                this.dispatchEvent(new CustomEvent("execution_start", { detail: msg.data }));
                break;
              case "execution_error":
                this.dispatchEvent(new CustomEvent("execution_error", { detail: msg.data }));
                break;
              case "execution_cached":
                this.dispatchEvent(new CustomEvent("execution_cached", { detail: msg.data }));
                break;
              default:
                if (this.#registered.has(msg.type)) {
                  this.dispatchEvent(new CustomEvent(msg.type, { detail: msg.data }));
                } else {
                  throw new Error(`Unknown message type ${msg.type}`);
                }
            }
          }
        } catch (error) {
          console.warn("Unhandled message:", event.data, error);
        }
      });
    }
    /**
     * Initialises sockets and realtime updates
     */
    init() {
      this.#createSocket();
    }
    /**
     * Gets a list of extension urls
     * @returns An array of script urls to import
     */
    async getExtensions() {
      const resp = await this.fetchApi("/extensions", { cache: "no-store" });
      return await resp.json();
    }
    /**
     * Gets a list of embedding names
     * @returns An array of script urls to import
     */
    async getEmbeddings() {
      const resp = await this.fetchApi("/embeddings", { cache: "no-store" });
      return await resp.json();
    }
    /**
     * Loads node object definitions for the graph
     * @returns The node definitions
     */
    async getNodeDefs() {
      const resp = await this.fetchApi("/object_info", { cache: "no-store" });
      return await resp.json();
    }
    /**
     *
     * @param {number} number The index at which to queue the prompt, passing -1 will insert the prompt at the front of the queue
     * @param {object} prompt The prompt data to queue
     */
    async queuePrompt(number, { output, workflow }) {
      const body = {
        client_id: this.clientId,
        prompt: output,
        extra_data: { extra_pnginfo: { workflow } }
      };
      if (number === -1) {
        body.front = true;
      } else if (number != 0) {
        body.number = number;
      }
      const res = await this.fetchApi("/prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (res.status !== 200) {
        throw {
          response: await res.json()
        };
      }
      return await res.json();
    }
    /**
     * Loads a list of items (queue or history)
     * @param {string} type The type of items to load, queue or history
     * @returns The items of the specified type grouped by their status
     */
    async getItems(type) {
      if (type === "queue") {
        return this.getQueue();
      }
      return this.getHistory();
    }
    /**
     * Gets the current state of the queue
     * @returns The currently running and queued items
     */
    async getQueue() {
      try {
        const res = await this.fetchApi("/queue");
        const data = await res.json();
        return {
          // Running action uses a different endpoint for cancelling
          Running: data.queue_running.map((prompt2) => ({
            prompt: prompt2,
            remove: { name: "Cancel", cb: () => api.interrupt() }
          })),
          Pending: data.queue_pending.map((prompt2) => ({ prompt: prompt2 }))
        };
      } catch (error) {
        console.error(error);
        return { Running: [], Pending: [] };
      }
    }
    /**
     * Gets the prompt execution history
     * @returns Prompt history including node outputs
     */
    async getHistory(max_items = 200) {
      try {
        const res = await this.fetchApi(`/history?max_items=${max_items}`);
        return { History: Object.values(await res.json()) };
      } catch (error) {
        console.error(error);
        return { History: [] };
      }
    }
    /**
     * Gets system & device stats
     * @returns System stats such as python version, OS, per device info
     */
    async getSystemStats() {
      const res = await this.fetchApi("/system_stats");
      return await res.json();
    }
    /**
     * Sends a POST request to the API
     * @param {*} type The endpoint to post to
     * @param {*} body Optional POST data
     */
    async #postItem(type, body) {
      try {
        await this.fetchApi("/" + type, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: body ? JSON.stringify(body) : void 0
        });
      } catch (error) {
        console.error(error);
      }
    }
    /**
     * Deletes an item from the specified list
     * @param {string} type The type of item to delete, queue or history
     * @param {number} id The id of the item to delete
     */
    async deleteItem(type, id) {
      await this.#postItem(type, { delete: [id] });
    }
    /**
     * Clears the specified list
     * @param {string} type The type of list to clear, queue or history
     */
    async clearItems(type) {
      await this.#postItem(type, { clear: true });
    }
    /**
     * Interrupts the execution of the running prompt
     */
    async interrupt() {
      await this.#postItem("interrupt", null);
    }
  };
  var api = new ComfyApi();

  // scripts/ui.js
  function $el(tag, propsOrChildren, children) {
    const split = tag.split(".");
    const element = document.createElement(split.shift());
    if (split.length > 0) {
      element.classList.add(...split);
    }
    if (propsOrChildren) {
      if (Array.isArray(propsOrChildren)) {
        element.append(...propsOrChildren);
      } else {
        const { parent, $: cb, dataset, style } = propsOrChildren;
        delete propsOrChildren.parent;
        delete propsOrChildren.$;
        delete propsOrChildren.dataset;
        delete propsOrChildren.style;
        if (Object.hasOwn(propsOrChildren, "for")) {
          element.setAttribute("for", propsOrChildren.for);
        }
        if (style) {
          Object.assign(element.style, style);
        }
        if (dataset) {
          Object.assign(element.dataset, dataset);
        }
        Object.assign(element, propsOrChildren);
        if (children) {
          element.append(...children);
        }
        if (parent) {
          parent.append(element);
        }
        if (cb) {
          cb(element);
        }
      }
    }
    return element;
  }
  function dragElement(dragEl, settings) {
    var posDiffX = 0, posDiffY = 0, posStartX = 0, posStartY = 0, newPosX = 0, newPosY = 0;
    if (dragEl.getElementsByClassName("drag-handle")[0]) {
      dragEl.getElementsByClassName("drag-handle")[0].onmousedown = dragMouseDown;
    } else {
      dragEl.onmousedown = dragMouseDown;
    }
    const resizeObserver = new ResizeObserver(() => {
      ensureInBounds();
    }).observe(dragEl);
    function ensureInBounds() {
      if (dragEl.classList.contains("comfy-menu-manual-pos")) {
        newPosX = Math.min(document.body.clientWidth - dragEl.clientWidth, Math.max(0, dragEl.offsetLeft));
        newPosY = Math.min(document.body.clientHeight - dragEl.clientHeight, Math.max(0, dragEl.offsetTop));
        positionElement();
      }
    }
    function positionElement() {
      const halfWidth = document.body.clientWidth / 2;
      const anchorRight = newPosX + dragEl.clientWidth / 2 > halfWidth;
      if (anchorRight) {
        dragEl.style.left = "unset";
        dragEl.style.right = document.body.clientWidth - newPosX - dragEl.clientWidth + "px";
      } else {
        dragEl.style.left = newPosX + "px";
        dragEl.style.right = "unset";
      }
      dragEl.style.top = newPosY + "px";
      dragEl.style.bottom = "unset";
      if (savePos) {
        localStorage.setItem(
          "Comfy.MenuPosition",
          JSON.stringify({
            x: dragEl.offsetLeft,
            y: dragEl.offsetTop
          })
        );
      }
    }
    function restorePos() {
      let pos = localStorage.getItem("Comfy.MenuPosition");
      if (pos) {
        pos = JSON.parse(pos);
        newPosX = pos.x;
        newPosY = pos.y;
        positionElement();
        ensureInBounds();
      }
    }
    let savePos = void 0;
    settings.addSetting({
      id: "Comfy.MenuPosition",
      name: "Save menu position",
      type: "boolean",
      defaultValue: savePos,
      onChange(value) {
        if (savePos === void 0 && value) {
          restorePos();
        }
        savePos = value;
      }
    });
    function dragMouseDown(e) {
      e = e || window.event;
      e.preventDefault();
      posStartX = e.clientX;
      posStartY = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }
    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      dragEl.classList.add("comfy-menu-manual-pos");
      posDiffX = e.clientX - posStartX;
      posDiffY = e.clientY - posStartY;
      posStartX = e.clientX;
      posStartY = e.clientY;
      newPosX = Math.min(document.body.clientWidth - dragEl.clientWidth, Math.max(0, dragEl.offsetLeft + posDiffX));
      newPosY = Math.min(document.body.clientHeight - dragEl.clientHeight, Math.max(0, dragEl.offsetTop + posDiffY));
      positionElement();
    }
    window.addEventListener("resize", () => {
      ensureInBounds();
    });
    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }
  var ComfyDialog = class {
    constructor() {
      this.element = $el("div.comfy-modal", { parent: document.body }, [
        $el("div.comfy-modal-content", [$el("p", { $: (p) => this.textElement = p }), ...this.createButtons()])
      ]);
    }
    createButtons() {
      return [
        $el("button", {
          type: "button",
          textContent: "Close",
          onclick: () => this.close()
        })
      ];
    }
    close() {
      this.element.style.display = "none";
    }
    show(html) {
      if (typeof html === "string") {
        this.textElement.innerHTML = html;
      } else {
        this.textElement.replaceChildren(html);
      }
      this.element.style.display = "flex";
    }
  };
  var ComfySettingsDialog = class extends ComfyDialog {
    constructor() {
      super();
      this.element = $el("dialog", {
        id: "comfy-settings-dialog",
        parent: document.body
      }, [
        $el("table.comfy-modal-content.comfy-table", [
          $el("caption", { textContent: "Settings" }),
          $el("tbody", { $: (tbody) => this.textElement = tbody }),
          $el("button", {
            type: "button",
            textContent: "Close",
            style: {
              cursor: "pointer"
            },
            onclick: () => {
              this.element.close();
            }
          })
        ])
      ]);
      this.settings = [];
    }
    getSettingValue(id, defaultValue) {
      const settingId = "Comfy.Settings." + id;
      const v = localStorage[settingId];
      return v == null ? defaultValue : JSON.parse(v);
    }
    setSettingValue(id, value) {
      const settingId = "Comfy.Settings." + id;
      localStorage[settingId] = JSON.stringify(value);
    }
    addSetting({ id, name, type, defaultValue, onChange, attrs = {}, tooltip = "", options = void 0 }) {
      if (!id) {
        throw new Error("Settings must have an ID");
      }
      if (this.settings.find((s) => s.id === id)) {
        throw new Error(`Setting ${id} of type ${type} must have a unique ID.`);
      }
      const settingId = `Comfy.Settings.${id}`;
      const v = localStorage[settingId];
      let value = v == null ? defaultValue : JSON.parse(v);
      if (onChange) {
        onChange(value, void 0);
      }
      this.settings.push({
        render: () => {
          const setter = (v2) => {
            if (onChange) {
              onChange(v2, value);
            }
            localStorage[settingId] = JSON.stringify(v2);
            value = v2;
          };
          value = this.getSettingValue(id, defaultValue);
          let element;
          const htmlID = id.replaceAll(".", "-");
          const labelCell = $el("td", [
            $el("label", {
              for: htmlID,
              classList: [tooltip !== "" ? "comfy-tooltip-indicator" : ""],
              textContent: name
            })
          ]);
          if (typeof type === "function") {
            element = type(name, setter, value, attrs);
          } else {
            switch (type) {
              case "boolean":
                element = $el("tr", [
                  labelCell,
                  $el("td", [
                    $el("input", {
                      id: htmlID,
                      type: "checkbox",
                      checked: value,
                      onchange: (event) => {
                        const isChecked = event.target.checked;
                        if (onChange !== void 0) {
                          onChange(isChecked);
                        }
                        this.setSettingValue(id, isChecked);
                      }
                    })
                  ])
                ]);
                break;
              case "number":
                element = $el("tr", [
                  labelCell,
                  $el("td", [
                    $el("input", {
                      type,
                      value,
                      id: htmlID,
                      oninput: (e) => {
                        setter(e.target.value);
                      },
                      ...attrs
                    })
                  ])
                ]);
                break;
              case "slider":
                element = $el("tr", [
                  labelCell,
                  $el("td", [
                    $el("div", {
                      style: {
                        display: "grid",
                        gridAutoFlow: "column"
                      }
                    }, [
                      $el("input", {
                        ...attrs,
                        value,
                        type: "range",
                        oninput: (e) => {
                          setter(e.target.value);
                          e.target.nextElementSibling.value = e.target.value;
                        }
                      }),
                      $el("input", {
                        ...attrs,
                        value,
                        id: htmlID,
                        type: "number",
                        style: { maxWidth: "4rem" },
                        oninput: (e) => {
                          setter(e.target.value);
                          e.target.previousElementSibling.value = e.target.value;
                        }
                      })
                    ])
                  ])
                ]);
                break;
              case "combo":
                element = $el("tr", [
                  labelCell,
                  $el("td", [
                    $el(
                      "select",
                      {
                        oninput: (e) => {
                          setter(e.target.value);
                        }
                      },
                      (typeof options === "function" ? options(value) : options || []).map((opt) => {
                        if (typeof opt === "string") {
                          opt = { text: opt };
                        }
                        const v2 = opt.value ?? opt.text;
                        return $el("option", {
                          value: v2,
                          textContent: opt.text,
                          selected: value + "" === v2 + ""
                        });
                      })
                    )
                  ])
                ]);
                break;
              case "text":
              default:
                if (type !== "text") {
                  console.warn(`Unsupported setting type '${type}, defaulting to text`);
                }
                element = $el("tr", [
                  labelCell,
                  $el("td", [
                    $el("input", {
                      value,
                      id: htmlID,
                      oninput: (e) => {
                        setter(e.target.value);
                      },
                      ...attrs
                    })
                  ])
                ]);
                break;
            }
          }
          if (tooltip) {
            element.title = tooltip;
          }
          return element;
        }
      });
      const self = this;
      return {
        get value() {
          return self.getSettingValue(id, defaultValue);
        },
        set value(v2) {
          self.setSettingValue(id, v2);
        }
      };
    }
    show() {
      this.textElement.replaceChildren(
        $el("tr", {
          style: { display: "none" }
        }, [
          $el("th"),
          $el("th", { style: { width: "33%" } })
        ]),
        ...this.settings.map((s) => s.render())
      );
      this.element.showModal();
    }
  };
  var ComfyList = class {
    #type;
    #text;
    #reverse;
    constructor(text, type, reverse) {
      this.#text = text;
      this.#type = type || text.toLowerCase();
      this.#reverse = reverse || false;
      this.element = $el("div.comfy-list");
      this.element.style.display = "none";
    }
    get visible() {
      return this.element.style.display !== "none";
    }
    async load() {
      const items = await api.getItems(this.#type);
      this.element.replaceChildren(
        ...Object.keys(items).flatMap((section) => [
          $el("h4", {
            textContent: section
          }),
          $el("div.comfy-list-items", [
            ...(this.#reverse ? items[section].reverse() : items[section]).map((item) => {
              const removeAction = item.remove || {
                name: "Delete",
                cb: () => api.deleteItem(this.#type, item.prompt[1])
              };
              return $el("div", { textContent: item.prompt[0] + ": " }, [
                $el("button", {
                  textContent: "Load",
                  onclick: () => {
                    app.loadGraphData(item.prompt[3].extra_pnginfo.workflow);
                    if (item.outputs) {
                      app.nodeOutputs = item.outputs;
                    }
                  }
                }),
                $el("button", {
                  textContent: removeAction.name,
                  onclick: async () => {
                    await removeAction.cb();
                    await this.update();
                  }
                })
              ]);
            })
          ])
        ]),
        $el("div.comfy-list-actions", [
          $el("button", {
            textContent: "Clear " + this.#text,
            onclick: async () => {
              await api.clearItems(this.#type);
              await this.load();
            }
          }),
          $el("button", { textContent: "Refresh", onclick: () => this.load() })
        ])
      );
    }
    async update() {
      if (this.visible) {
        await this.load();
      }
    }
    async show() {
      this.element.style.display = "block";
      this.button.textContent = "Close";
      await this.load();
    }
    hide() {
      this.element.style.display = "none";
      this.button.textContent = "View " + this.#text;
    }
    toggle() {
      if (this.visible) {
        this.hide();
        return false;
      } else {
        this.show();
        return true;
      }
    }
  };
  var ComfyUI = class {
    constructor(app3) {
      this.app = app3;
      this.dialog = new ComfyDialog();
      this.settings = new ComfySettingsDialog();
      this.batchCount = 1;
      this.lastQueueSize = 0;
      this.queue = new ComfyList("Queue");
      this.history = new ComfyList("History", "history", true);
      api.addEventListener("status", () => {
        this.queue.update();
        this.history.update();
      });
      const confirmClear = this.settings.addSetting({
        id: "Comfy.ConfirmClear",
        name: "Require confirmation when clearing workflow",
        type: "boolean",
        defaultValue: true
      });
      const promptFilename = this.settings.addSetting({
        id: "Comfy.PromptFilename",
        name: "Prompt for filename when saving workflow",
        type: "boolean",
        defaultValue: true
      });
      const previewImage = this.settings.addSetting({
        id: "Comfy.PreviewFormat",
        name: "When displaying a preview in the image widget, convert it to a lightweight image, e.g. webp, jpeg, webp;50, etc.",
        type: "text",
        defaultValue: ""
      });
      this.settings.addSetting({
        id: "Comfy.DisableSliders",
        name: "Disable sliders.",
        type: "boolean",
        defaultValue: false
      });
      this.settings.addSetting({
        id: "Comfy.DisableFloatRounding",
        name: "Disable rounding floats (requires page reload).",
        type: "boolean",
        defaultValue: false
      });
      this.settings.addSetting({
        id: "Comfy.FloatRoundingPrecision",
        name: "Decimal places [0 = auto] (requires page reload).",
        type: "slider",
        attrs: {
          min: 0,
          max: 6,
          step: 1
        },
        defaultValue: 0
      });
      const fileInput2 = $el("input", {
        id: "comfy-file-input",
        type: "file",
        accept: ".json,image/png,.latent,.safetensors,image/webp",
        style: { display: "none" },
        parent: document.body,
        onchange: () => {
          app3.handleFile(fileInput2.files[0]);
        }
      });
      this.menuContainer = $el("div.comfy-menu", { parent: document.body }, [
        $el("div.drag-handle", {
          style: {
            overflow: "hidden",
            position: "relative",
            width: "100%",
            cursor: "default"
          }
        }, [
          $el("span.drag-handle"),
          $el("span", { $: (q) => this.queueSize = q }),
          $el("button.comfy-settings-btn", { textContent: "\u2699\uFE0F", onclick: () => this.settings.show() })
        ]),
        $el("button.comfy-queue-btn", {
          id: "queue-button",
          textContent: "Queue Prompt",
          onclick: () => app3.queuePrompt(0, this.batchCount)
        }),
        $el("div", {}, [
          $el("label", { innerHTML: "Extra options" }, [
            $el("input", {
              type: "checkbox",
              onchange: (i) => {
                document.getElementById("extraOptions").style.display = i.srcElement.checked ? "block" : "none";
                this.batchCount = i.srcElement.checked ? document.getElementById("batchCountInputRange").value : 1;
                document.getElementById("autoQueueCheckbox").checked = false;
              }
            })
          ])
        ]),
        $el("div", { id: "extraOptions", style: { width: "100%", display: "none" } }, [
          $el("div", [
            $el("label", { innerHTML: "Batch count" }),
            $el("input", {
              id: "batchCountInputNumber",
              type: "number",
              value: this.batchCount,
              min: "1",
              style: { width: "35%", "margin-left": "0.4em" },
              oninput: (i) => {
                this.batchCount = i.target.value;
                document.getElementById("batchCountInputRange").value = this.batchCount;
              }
            }),
            $el("input", {
              id: "batchCountInputRange",
              type: "range",
              min: "1",
              max: "100",
              value: this.batchCount,
              oninput: (i) => {
                this.batchCount = i.srcElement.value;
                document.getElementById("batchCountInputNumber").value = i.srcElement.value;
              }
            })
          ]),
          $el("div", [
            $el("label", {
              for: "autoQueueCheckbox",
              innerHTML: "Auto Queue"
              // textContent: "Auto Queue"
            }),
            $el("input", {
              id: "autoQueueCheckbox",
              type: "checkbox",
              checked: false,
              title: "Automatically queue prompt when the queue size hits 0"
            })
          ])
        ]),
        $el("div.comfy-menu-btns", [
          $el("button", {
            id: "queue-front-button",
            textContent: "Queue Front",
            onclick: () => app3.queuePrompt(-1, this.batchCount)
          }),
          $el("button", {
            $: (b) => this.queue.button = b,
            id: "comfy-view-queue-button",
            textContent: "View Queue",
            onclick: () => {
              this.history.hide();
              this.queue.toggle();
            }
          }),
          $el("button", {
            $: (b) => this.history.button = b,
            id: "comfy-view-history-button",
            textContent: "View History",
            onclick: () => {
              this.queue.hide();
              this.history.toggle();
            }
          })
        ]),
        this.queue.element,
        this.history.element,
        $el("button", {
          id: "comfy-save-button",
          textContent: "Save",
          onclick: () => {
            let filename = "workflow.json";
            if (promptFilename.value) {
              filename = prompt("Save workflow as:", filename);
              if (!filename)
                return;
              if (!filename.toLowerCase().endsWith(".json")) {
                filename += ".json";
              }
            }
            app3.graphToPrompt().then((p) => {
              const json = JSON.stringify(p.workflow, null, 2);
              const blob = new Blob([json], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = $el("a", {
                href: url,
                download: filename,
                style: { display: "none" },
                parent: document.body
              });
              a.click();
              setTimeout(function() {
                a.remove();
                window.URL.revokeObjectURL(url);
              }, 0);
            });
          }
        }),
        $el("button", {
          id: "comfy-dev-save-api-button",
          textContent: "Save (API Format)",
          style: { width: "100%", display: "none" },
          onclick: () => {
            let filename = "workflow_api.json";
            if (promptFilename.value) {
              filename = prompt("Save workflow (API) as:", filename);
              if (!filename)
                return;
              if (!filename.toLowerCase().endsWith(".json")) {
                filename += ".json";
              }
            }
            app3.graphToPrompt().then((p) => {
              const json = JSON.stringify(p.output, null, 2);
              const blob = new Blob([json], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = $el("a", {
                href: url,
                download: filename,
                style: { display: "none" },
                parent: document.body
              });
              a.click();
              setTimeout(function() {
                a.remove();
                window.URL.revokeObjectURL(url);
              }, 0);
            });
          }
        }),
        $el("button", { id: "comfy-load-button", textContent: "Load", onclick: () => fileInput2.click() }),
        $el("button", {
          id: "comfy-refresh-button",
          textContent: "Refresh",
          onclick: () => app3.refreshComboInNodes()
        }),
        $el("button", { id: "comfy-clipspace-button", textContent: "Clipspace", onclick: () => app3.openClipspace() }),
        $el("button", {
          id: "comfy-clear-button",
          textContent: "Clear",
          onclick: () => {
            if (!confirmClear.value || confirm("Clear workflow?")) {
              app3.clean();
              app3.graph.clear();
            }
          }
        }),
        $el("button", {
          id: "comfy-load-default-button",
          textContent: "Load Default",
          onclick: () => {
            if (!confirmClear.value || confirm("Load default workflow?")) {
              app3.loadGraphData();
            }
          }
        })
      ]);
      const devMode = this.settings.addSetting({
        id: "Comfy.DevMode",
        name: "Enable Dev mode Options",
        type: "boolean",
        defaultValue: false,
        onChange: function(value) {
          document.getElementById("comfy-dev-save-api-button").style.display = value ? "block" : "none";
        }
      });
      dragElement(this.menuContainer, this.settings);
      this.setStatus({ exec_info: { queue_remaining: "X" } });
    }
    setStatus(status) {
      this.queueSize.textContent = "Queue size: " + (status ? status.exec_info.queue_remaining : "ERR");
      if (status) {
        if (this.lastQueueSize != 0 && status.exec_info.queue_remaining == 0 && document.getElementById("autoQueueCheckbox").checked && !app.lastExecutionError) {
          app.queuePrompt(0, this.batchCount);
        }
        this.lastQueueSize = status.exec_info.queue_remaining;
      }
    }
  };

  // scripts/logging.js
  $el("style", {
    textContent: `
        .comfy-logging-logs {
            display: grid;
            color: var(--fg-color);
            white-space: pre-wrap;
        }
        .comfy-logging-log {
            display: contents;
        }
        .comfy-logging-title {
            background: var(--tr-even-bg-color);
            font-weight: bold;
            margin-bottom: 5px;
            text-align: center;
        }
        .comfy-logging-log div {
            background: var(--row-bg);
            padding: 5px;
        }
    `,
    parent: document.body
  });
  function stringify(val, depth, replacer, space, onGetObjID) {
    depth = isNaN(+depth) ? 1 : depth;
    var recursMap = /* @__PURE__ */ new WeakMap();
    function _build(val2, depth2, o, a, r) {
      return !val2 || typeof val2 != "object" ? val2 : (r = recursMap.has(val2), recursMap.set(val2, true), a = Array.isArray(val2), r ? o = onGetObjID && onGetObjID(val2) || null : JSON.stringify(val2, function(k, v) {
        if (a || depth2 > 0) {
          if (replacer)
            v = replacer(k, v);
          if (!k)
            return a = Array.isArray(v), val2 = v;
          !o && (o = a ? [] : {});
          o[k] = _build(v, a ? depth2 : depth2 - 1);
        }
      }), o === void 0 ? a ? [] : {} : o);
    }
    return JSON.stringify(_build(val, depth), null, space);
  }
  var jsonReplacer = (k, v, ui) => {
    if (v instanceof Array && v.length === 1) {
      v = v[0];
    }
    if (v instanceof Date) {
      v = v.toISOString();
      if (ui) {
        v = v.split("T")[1];
      }
    }
    if (v instanceof Error) {
      let err = "";
      if (v.name)
        err += v.name + "\n";
      if (v.message)
        err += v.message + "\n";
      if (v.stack)
        err += v.stack + "\n";
      if (!err) {
        err = v.toString();
      }
      v = err;
    }
    return v;
  };
  var fileInput = $el("input", {
    type: "file",
    accept: ".json",
    style: { display: "none" },
    parent: document.body
  });
  var ComfyLoggingDialog = class extends ComfyDialog {
    constructor(logging) {
      super();
      this.logging = logging;
    }
    clear() {
      this.logging.clear();
      this.show();
    }
    export() {
      const blob = new Blob([stringify([...this.logging.entries], 20, jsonReplacer, "	")], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const a = $el("a", {
        href: url,
        download: `comfyui-logs-${Date.now()}.json`,
        style: { display: "none" },
        parent: document.body
      });
      a.click();
      setTimeout(function() {
        a.remove();
        window.URL.revokeObjectURL(url);
      }, 0);
    }
    import() {
      fileInput.onchange = () => {
        const reader = new FileReader();
        reader.onload = () => {
          fileInput.remove();
          try {
            const obj = JSON.parse(reader.result);
            if (obj instanceof Array) {
              this.show(obj);
            } else {
              throw new Error("Invalid file selected.");
            }
          } catch (error) {
            alert("Unable to load logs: " + error.message);
          }
        };
        reader.readAsText(fileInput.files[0]);
      };
      fileInput.click();
    }
    createButtons() {
      return [
        $el("button", {
          type: "button",
          textContent: "Clear",
          onclick: () => this.clear()
        }),
        $el("button", {
          type: "button",
          textContent: "Export logs...",
          onclick: () => this.export()
        }),
        $el("button", {
          type: "button",
          textContent: "View exported logs...",
          onclick: () => this.import()
        }),
        ...super.createButtons()
      ];
    }
    getTypeColor(type) {
      switch (type) {
        case "error":
          return "red";
        case "warn":
          return "orange";
        case "debug":
          return "dodgerblue";
      }
    }
    show(entries) {
      if (!entries)
        entries = this.logging.entries;
      this.element.style.width = "100%";
      const cols = {
        source: "Source",
        type: "Type",
        timestamp: "Timestamp",
        message: "Message"
      };
      const keys = Object.keys(cols);
      const headers = Object.values(cols).map(
        (title) => $el("div.comfy-logging-title", {
          textContent: title
        })
      );
      const rows = entries.map((entry, i) => {
        return $el(
          "div.comfy-logging-log",
          {
            $: (el) => el.style.setProperty("--row-bg", `var(--tr-${i % 2 ? "even" : "odd"}-bg-color)`)
          },
          keys.map((key) => {
            let v = entry[key];
            let color;
            if (key === "type") {
              color = this.getTypeColor(v);
            } else {
              v = jsonReplacer(key, v, true);
              if (typeof v === "object") {
                v = stringify(v, 5, jsonReplacer, "  ");
              }
            }
            return $el("div", {
              style: {
                color
              },
              textContent: v
            });
          })
        );
      });
      const grid = $el(
        "div.comfy-logging-logs",
        {
          style: {
            gridTemplateColumns: `repeat(${headers.length}, 1fr)`
          }
        },
        [...headers, ...rows]
      );
      const els = [grid];
      if (!this.logging.enabled) {
        els.unshift(
          $el("h3", {
            style: { textAlign: "center" },
            textContent: "Logging is disabled"
          })
        );
      }
      super.show($el("div", els));
    }
  };
  var ComfyLogging = class {
    /**
     * @type Array<{ source: string, type: string, timestamp: Date, message: any }>
     */
    entries = [];
    #enabled;
    #console = {};
    get enabled() {
      return this.#enabled;
    }
    set enabled(value) {
      if (value === this.#enabled)
        return;
      if (value) {
        this.patchConsole();
      } else {
        this.unpatchConsole();
      }
      this.#enabled = value;
    }
    constructor(app3) {
      this.app = app3;
      this.dialog = new ComfyLoggingDialog(this);
      this.addSetting();
      this.catchUnhandled();
      this.addInitData();
    }
    addSetting() {
      const settingId = "Comfy.Logging.Enabled";
      const htmlSettingId = settingId.replaceAll(".", "-");
      const setting = this.app.ui.settings.addSetting({
        id: settingId,
        name: settingId,
        defaultValue: true,
        type: (name, setter, value) => {
          return $el("tr", [
            $el("td", [
              $el("label", {
                textContent: "Logging",
                for: htmlSettingId
              })
            ]),
            $el("td", [
              $el("input", {
                id: htmlSettingId,
                type: "checkbox",
                checked: value,
                onchange: (event) => {
                  setter(this.enabled = event.target.checked);
                }
              }),
              $el("button", {
                textContent: "View Logs",
                onclick: () => {
                  this.app.ui.settings.element.close();
                  this.dialog.show();
                },
                style: {
                  fontSize: "14px",
                  display: "block",
                  marginTop: "5px"
                }
              })
            ])
          ]);
        }
      });
      this.enabled = setting.value;
    }
    patchConsole() {
      const self = this;
      for (const type of ["log", "warn", "error", "debug"]) {
        const orig = console[type];
        this.#console[type] = orig;
        console[type] = function() {
          orig.apply(console, arguments);
          self.addEntry("console", type, ...arguments);
        };
      }
    }
    unpatchConsole() {
      for (const type of Object.keys(this.#console)) {
        console[type] = this.#console[type];
      }
      this.#console = {};
    }
    catchUnhandled() {
      window.addEventListener("error", (e) => {
        this.addEntry("window", "error", e.error ?? "Unknown error");
        return false;
      });
      window.addEventListener("unhandledrejection", (e) => {
        this.addEntry("unhandledrejection", "error", e.reason ?? "Unknown error");
      });
    }
    clear() {
      this.entries = [];
    }
    addEntry(source, type, ...args) {
      if (this.enabled) {
        this.entries.push({
          source,
          type,
          timestamp: /* @__PURE__ */ new Date(),
          message: args
        });
      }
    }
    log(source, ...args) {
      this.addEntry(source, "log", ...args);
    }
    async addInitData() {
      if (!this.enabled)
        return;
      const source = "ComfyUI.Logging";
      this.addEntry(source, "debug", { UserAgent: navigator.userAgent });
      const systemStats = await api.getSystemStats();
      this.addEntry(source, "debug", systemStats);
    }
  };

  // scripts/domWidget.js
  var SIZE = Symbol();
  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const num1 = Math.min(a.x + a.width, b.x + b.width);
    const y = Math.max(a.y, b.y);
    const num2 = Math.min(a.y + a.height, b.y + b.height);
    if (num1 >= x && num2 >= y)
      return [x, y, num1 - x, num2 - y];
    else
      return null;
  }
  function getClipPath(node, element, elRect) {
    const selectedNode = Object.values(app2.canvas.selected_nodes)[0];
    if (selectedNode && selectedNode !== node) {
      const MARGIN = 7;
      const scale = app2.canvas.ds.scale;
      const bounding = selectedNode.getBounding();
      const intersection = intersect(
        { x: elRect.x / scale, y: elRect.y / scale, width: elRect.width / scale, height: elRect.height / scale },
        {
          x: selectedNode.pos[0] + app2.canvas.ds.offset[0] - MARGIN,
          y: selectedNode.pos[1] + app2.canvas.ds.offset[1] - LiteGraph.NODE_TITLE_HEIGHT - MARGIN,
          width: bounding[2] + MARGIN + MARGIN,
          height: bounding[3] + MARGIN + MARGIN
        }
      );
      if (!intersection) {
        return "";
      }
      const widgetRect = element.getBoundingClientRect();
      const clipX = intersection[0] - widgetRect.x / scale + "px";
      const clipY = intersection[1] - widgetRect.y / scale + "px";
      const clipWidth = intersection[2] + "px";
      const clipHeight = intersection[3] + "px";
      const path = `polygon(0% 0%, 0% 100%, ${clipX} 100%, ${clipX} ${clipY}, calc(${clipX} + ${clipWidth}) ${clipY}, calc(${clipX} + ${clipWidth}) calc(${clipY} + ${clipHeight}), ${clipX} calc(${clipY} + ${clipHeight}), ${clipX} 100%, 100% 100%, 100% 0%)`;
      return path;
    }
    return "";
  }
  function computeSize(size) {
    if (this.widgets?.[0].last_y == null)
      return;
    let y = this.widgets[0].last_y;
    let freeSpace = size[1] - y;
    let widgetHeight = 0;
    let dom = [];
    for (const w of this.widgets) {
      if (w.type === "converted-widget") {
        delete w.computedHeight;
      } else if (w.computeSize) {
        widgetHeight += w.computeSize()[1] + 4;
      } else if (w.element) {
        const styles = getComputedStyle(w.element);
        let minHeight = w.options.getMinHeight?.() ?? parseInt(styles.getPropertyValue("--comfy-widget-min-height"));
        let maxHeight = w.options.getMaxHeight?.() ?? parseInt(styles.getPropertyValue("--comfy-widget-max-height"));
        let prefHeight = w.options.getHeight?.() ?? styles.getPropertyValue("--comfy-widget-height");
        if (prefHeight.endsWith?.("%")) {
          prefHeight = size[1] * (parseFloat(prefHeight.substring(0, prefHeight.length - 1)) / 100);
        } else {
          prefHeight = parseInt(prefHeight);
          if (isNaN(minHeight)) {
            minHeight = prefHeight;
          }
        }
        if (isNaN(minHeight)) {
          minHeight = 50;
        }
        if (!isNaN(maxHeight)) {
          if (!isNaN(prefHeight)) {
            prefHeight = Math.min(prefHeight, maxHeight);
          } else {
            prefHeight = maxHeight;
          }
        }
        dom.push({
          minHeight,
          prefHeight,
          w
        });
      } else {
        widgetHeight += LiteGraph.NODE_WIDGET_HEIGHT + 4;
      }
    }
    freeSpace -= widgetHeight;
    const prefGrow = [];
    const canGrow = [];
    let growBy = 0;
    for (const d of dom) {
      freeSpace -= d.minHeight;
      if (isNaN(d.prefHeight)) {
        canGrow.push(d);
        d.w.computedHeight = d.minHeight;
      } else {
        const diff = d.prefHeight - d.minHeight;
        if (diff > 0) {
          prefGrow.push(d);
          growBy += diff;
          d.diff = diff;
        } else {
          d.w.computedHeight = d.minHeight;
        }
      }
    }
    if (this.imgs && !this.widgets.find((w) => w.name === ANIM_PREVIEW_WIDGET)) {
      freeSpace -= 220;
    }
    if (freeSpace < 0) {
      size[1] -= freeSpace;
      this.graph.setDirtyCanvas(true);
    } else {
      const growDiff = freeSpace - growBy;
      if (growDiff > 0) {
        freeSpace = growDiff;
        for (const d of prefGrow) {
          d.w.computedHeight = d.prefHeight;
        }
      } else {
        const shared = -growDiff / prefGrow.length;
        for (const d of prefGrow) {
          d.w.computedHeight = d.prefHeight - shared;
        }
        freeSpace = 0;
      }
      if (freeSpace > 0 && canGrow.length) {
        const shared = freeSpace / canGrow.length;
        for (const d of canGrow) {
          d.w.computedHeight += shared;
        }
      }
    }
    for (const w of this.widgets) {
      w.y = y;
      if (w.computedHeight) {
        y += w.computedHeight;
      } else if (w.computeSize) {
        y += w.computeSize()[1] + 4;
      } else {
        y += LiteGraph.NODE_WIDGET_HEIGHT + 4;
      }
    }
  }
  var elementWidgets = /* @__PURE__ */ new Set();
  var computeVisibleNodes = LGraphCanvas.prototype.computeVisibleNodes;
  LGraphCanvas.prototype.computeVisibleNodes = function() {
    const visibleNodes = computeVisibleNodes.apply(this, arguments);
    for (const node of app2.graph._nodes) {
      if (elementWidgets.has(node)) {
        const hidden = visibleNodes.indexOf(node) === -1;
        for (const w of node.widgets) {
          if (w.element) {
            w.element.hidden = hidden;
            if (hidden) {
              w.options.onHide?.(w);
            }
          }
        }
      }
    }
    return visibleNodes;
  };
  var enableDomClipping = true;
  function addDomClippingSetting() {
    app2.ui.settings.addSetting({
      id: "Comfy.DOMClippingEnabled",
      name: "Enable DOM element clipping (enabling may reduce performance)",
      type: "boolean",
      defaultValue: enableDomClipping,
      onChange(value) {
        console.log("enableDomClipping", enableDomClipping);
        enableDomClipping = !!value;
      }
    });
  }
  LGraphNode.prototype.addDOMWidget = function(name, type, element, options) {
    options = { hideOnZoom: true, selectOn: ["focus", "click"], ...options };
    if (!element.parentElement) {
      document.body.append(element);
    }
    let mouseDownHandler;
    if (element.blur) {
      mouseDownHandler = (event) => {
        if (!element.contains(event.target)) {
          element.blur();
        }
      };
      document.addEventListener("mousedown", mouseDownHandler);
    }
    const widget = {
      type,
      name,
      get value() {
        return options.getValue?.() ?? void 0;
      },
      set value(v) {
        options.setValue?.(v);
        widget.callback?.(widget.value);
      },
      draw: function(ctx, node, widgetWidth, y, widgetHeight) {
        if (widget.computedHeight == null) {
          computeSize.call(node, node.size);
        }
        const hidden = node.flags?.collapsed || !!options.hideOnZoom && app2.canvas.ds.scale < 0.5 || widget.computedHeight <= 0 || widget.type === "converted-widget";
        element.hidden = hidden;
        element.style.display = hidden ? "none" : null;
        if (hidden) {
          widget.options.onHide?.(widget);
          return;
        }
        const margin = 10;
        const elRect = ctx.canvas.getBoundingClientRect();
        const transform = new DOMMatrix().scaleSelf(elRect.width / ctx.canvas.width, elRect.height / ctx.canvas.height).multiplySelf(ctx.getTransform()).translateSelf(margin, margin + y);
        const scale = new DOMMatrix().scaleSelf(transform.a, transform.d);
        Object.assign(element.style, {
          transformOrigin: "0 0",
          transform: scale,
          left: `${transform.a + transform.e}px`,
          top: `${transform.d + transform.f}px`,
          width: `${widgetWidth - margin * 2}px`,
          height: `${(widget.computedHeight ?? 50) - margin * 2}px`,
          position: "absolute",
          zIndex: app2.graph._nodes.indexOf(node)
        });
        if (enableDomClipping) {
          element.style.clipPath = getClipPath(node, element, elRect);
          element.style.willChange = "clip-path";
        }
        this.options.onDraw?.(widget);
      },
      element,
      options,
      onRemove() {
        if (mouseDownHandler) {
          document.removeEventListener("mousedown", mouseDownHandler);
        }
        element.remove();
      }
    };
    for (const evt of options.selectOn) {
      element.addEventListener(evt, () => {
        app2.canvas.selectNode(this);
        app2.canvas.bringToFront(this);
      });
    }
    this.addCustomWidget(widget);
    elementWidgets.add(this);
    const collapse = this.collapse;
    this.collapse = function() {
      collapse.apply(this, arguments);
      if (this.flags?.collapsed) {
        element.hidden = true;
        element.style.display = "none";
      }
    };
    const onRemoved = this.onRemoved;
    this.onRemoved = function() {
      element.remove();
      elementWidgets.delete(this);
      onRemoved?.apply(this, arguments);
    };
    if (!this[SIZE]) {
      this[SIZE] = true;
      const onResize = this.onResize;
      this.onResize = function(size) {
        options.beforeResize?.call(widget, this);
        computeSize.call(this, size);
        onResize?.apply(this, arguments);
        options.afterResize?.call(widget, this);
      };
    }
    return widget;
  };

  // scripts/widgets.js
  function getNumberDefaults(inputData, defaultStep, precision, enable_rounding) {
    let defaultVal = inputData[1]["default"];
    let { min, max, step, round } = inputData[1];
    if (defaultVal == void 0)
      defaultVal = 0;
    if (min == void 0)
      min = 0;
    if (max == void 0)
      max = 2048;
    if (step == void 0)
      step = defaultStep;
    if (precision == void 0) {
      precision = Math.max(-Math.floor(Math.log10(step)), 0);
    }
    if (enable_rounding && (round == void 0 || round === true)) {
      round = Math.round(1e6 * Math.pow(0.1, precision)) / 1e6;
    }
    return { val: defaultVal, config: { min, max, step: 10 * step, round, precision } };
  }
  function addValueControlWidget(node, targetWidget, defaultValue = "randomize", values) {
    const widgets = addValueControlWidgets(node, targetWidget, defaultValue, values, {
      addFilterList: false
    });
    return widgets[0];
  }
  function addValueControlWidgets(node, targetWidget, defaultValue = "randomize", values, options) {
    if (!options)
      options = {};
    const widgets = [];
    const valueControl = node.addWidget("combo", "control_after_generate", defaultValue, function(v) {
    }, {
      values: ["fixed", "increment", "decrement", "randomize"],
      serialize: false
      // Don't include this in prompt.
    });
    widgets.push(valueControl);
    const isCombo = targetWidget.type === "combo";
    let comboFilter;
    if (isCombo && options.addFilterList !== false) {
      comboFilter = node.addWidget("string", "control_filter_list", "", function(v) {
      }, {
        serialize: false
        // Don't include this in prompt.
      });
      widgets.push(comboFilter);
    }
    valueControl.afterQueued = () => {
      var v = valueControl.value;
      if (isCombo && v !== "fixed") {
        let values2 = targetWidget.options.values;
        const filter = comboFilter?.value;
        if (filter) {
          let check;
          if (filter.startsWith("/") && filter.endsWith("/")) {
            try {
              const regex = new RegExp(filter.substring(1, filter.length - 1));
              check = (item) => regex.test(item);
            } catch (error) {
              console.error("Error constructing RegExp filter for node " + node.id, filter, error);
            }
          }
          if (!check) {
            const lower = filter.toLocaleLowerCase();
            check = (item) => item.toLocaleLowerCase().includes(lower);
          }
          values2 = values2.filter((item) => check(item));
          if (!values2.length && targetWidget.options.values.length) {
            console.warn("Filter for node " + node.id + " has filtered out all items", filter);
          }
        }
        let current_index = values2.indexOf(targetWidget.value);
        let current_length = values2.length;
        switch (v) {
          case "increment":
            current_index += 1;
            break;
          case "decrement":
            current_index -= 1;
            break;
          case "randomize":
            current_index = Math.floor(Math.random() * current_length);
          default:
            break;
        }
        current_index = Math.max(0, current_index);
        current_index = Math.min(current_length - 1, current_index);
        if (current_index >= 0) {
          let value = values2[current_index];
          targetWidget.value = value;
          targetWidget.callback(value);
        }
      } else {
        let min = targetWidget.options.min;
        let max = targetWidget.options.max;
        max = Math.min(1125899906842624, max);
        min = Math.max(-1125899906842624, min);
        let range = (max - min) / (targetWidget.options.step / 10);
        switch (v) {
          case "fixed":
            break;
          case "increment":
            targetWidget.value += targetWidget.options.step / 10;
            break;
          case "decrement":
            targetWidget.value -= targetWidget.options.step / 10;
            break;
          case "randomize":
            targetWidget.value = Math.floor(Math.random() * range) * (targetWidget.options.step / 10) + min;
          default:
            break;
        }
        if (targetWidget.value < min)
          targetWidget.value = min;
        if (targetWidget.value > max)
          targetWidget.value = max;
        targetWidget.callback(targetWidget.value);
      }
    };
    return widgets;
  }
  function seedWidget(node, inputName, inputData, app3) {
    const seed = ComfyWidgets.INT(node, inputName, inputData, app3);
    const seedControl = addValueControlWidget(node, seed.widget, "randomize");
    seed.widget.linkedWidgets = [seedControl];
    return seed;
  }
  function addMultilineWidget(node, name, opts, app3) {
    const inputEl = document.createElement("textarea");
    inputEl.className = "comfy-multiline-input";
    inputEl.value = opts.defaultVal;
    inputEl.placeholder = opts.placeholder || "";
    const widget = node.addDOMWidget(name, "customtext", inputEl, {
      getValue() {
        return inputEl.value;
      },
      setValue(v) {
        inputEl.value = v;
      }
    });
    widget.inputEl = inputEl;
    return { minWidth: 400, minHeight: 200, widget };
  }
  function isSlider(display, app3) {
    if (app3.ui.settings.getSettingValue("Comfy.DisableSliders")) {
      return "number";
    }
    return display === "slider" ? "slider" : "number";
  }
  var ComfyWidgets = {
    "INT:seed": seedWidget,
    "INT:noise_seed": seedWidget,
    FLOAT(node, inputName, inputData, app3) {
      let widgetType = isSlider(inputData[1]["display"], app3);
      let precision = app3.ui.settings.getSettingValue("Comfy.FloatRoundingPrecision");
      let disable_rounding = app3.ui.settings.getSettingValue("Comfy.DisableFloatRounding");
      if (precision == 0)
        precision = void 0;
      const { val, config } = getNumberDefaults(inputData, 0.5, precision, !disable_rounding);
      return { widget: node.addWidget(
        widgetType,
        inputName,
        val,
        function(v) {
          if (config.round) {
            this.value = Math.round(v / config.round) * config.round;
          } else {
            this.value = v;
          }
        },
        config
      ) };
    },
    INT(node, inputName, inputData, app3) {
      let widgetType = isSlider(inputData[1]["display"], app3);
      const { val, config } = getNumberDefaults(inputData, 1, 0, true);
      Object.assign(config, { precision: 0 });
      return {
        widget: node.addWidget(
          widgetType,
          inputName,
          val,
          function(v) {
            const s = this.options.step / 10;
            this.value = Math.round(v / s) * s;
          },
          config
        )
      };
    },
    BOOLEAN(node, inputName, inputData) {
      let defaultVal = false;
      let options = {};
      if (inputData[1]) {
        if (inputData[1].default)
          defaultVal = inputData[1].default;
        if (inputData[1].label_on)
          options["on"] = inputData[1].label_on;
        if (inputData[1].label_off)
          options["off"] = inputData[1].label_off;
      }
      return {
        widget: node.addWidget(
          "toggle",
          inputName,
          defaultVal,
          () => {
          },
          options
        )
      };
    },
    STRING(node, inputName, inputData, app3) {
      const defaultVal = inputData[1].default || "";
      const multiline = !!inputData[1].multiline;
      let res;
      if (multiline) {
        res = addMultilineWidget(node, inputName, { defaultVal, ...inputData[1] }, app3);
      } else {
        res = { widget: node.addWidget("text", inputName, defaultVal, () => {
        }, {}) };
      }
      if (inputData[1].dynamicPrompts != void 0)
        res.widget.dynamicPrompts = inputData[1].dynamicPrompts;
      return res;
    },
    COMBO(node, inputName, inputData) {
      const type = inputData[0];
      let defaultValue = type[0];
      if (inputData[1] && inputData[1].default) {
        defaultValue = inputData[1].default;
      }
      return { widget: node.addWidget("combo", inputName, defaultValue, () => {
      }, { values: type }) };
    },
    IMAGEUPLOAD(node, inputName, inputData, app3) {
      const imageWidget = node.widgets.find((w) => w.name === "image");
      let uploadWidget;
      function showImage(name) {
        const img = new Image();
        img.onload = () => {
          node.imgs = [img];
          app3.graph.setDirtyCanvas(true);
        };
        let folder_separator = name.lastIndexOf("/");
        let subfolder = "";
        if (folder_separator > -1) {
          subfolder = name.substring(0, folder_separator);
          name = name.substring(folder_separator + 1);
        }
        img.src = api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${subfolder}${app3.getPreviewFormatParam()}`);
        node.setSizeForImage?.();
      }
      var default_value = imageWidget.value;
      Object.defineProperty(imageWidget, "value", {
        set: function(value) {
          this._real_value = value;
        },
        get: function() {
          let value = "";
          if (this._real_value) {
            value = this._real_value;
          } else {
            return default_value;
          }
          if (value.filename) {
            let real_value = value;
            value = "";
            if (real_value.subfolder) {
              value = real_value.subfolder + "/";
            }
            value += real_value.filename;
            if (real_value.type && real_value.type !== "input")
              value += ` [${real_value.type}]`;
          }
          return value;
        }
      });
      const cb = node.callback;
      imageWidget.callback = function() {
        showImage(imageWidget.value);
        if (cb) {
          return cb.apply(this, arguments);
        }
      };
      requestAnimationFrame(() => {
        if (imageWidget.value) {
          showImage(imageWidget.value);
        }
      });
      async function uploadFile(file, updateNode, pasted = false) {
        try {
          const body = new FormData();
          body.append("image", file);
          if (pasted)
            body.append("subfolder", "pasted");
          const resp = await api.fetchApi("/upload/image", {
            method: "POST",
            body
          });
          if (resp.status === 200) {
            const data = await resp.json();
            let path = data.name;
            if (data.subfolder)
              path = data.subfolder + "/" + path;
            if (!imageWidget.options.values.includes(path)) {
              imageWidget.options.values.push(path);
            }
            if (updateNode) {
              showImage(path);
              imageWidget.value = path;
            }
          } else {
            alert(resp.status + " - " + resp.statusText);
          }
        } catch (error) {
          alert(error);
        }
      }
      const fileInput2 = document.createElement("input");
      Object.assign(fileInput2, {
        type: "file",
        accept: "image/jpeg,image/png,image/webp",
        style: "display: none",
        onchange: async () => {
          if (fileInput2.files.length) {
            await uploadFile(fileInput2.files[0], true);
          }
        }
      });
      document.body.append(fileInput2);
      uploadWidget = node.addWidget("button", "choose file to upload", "image", () => {
        fileInput2.click();
      });
      uploadWidget.serialize = false;
      node.onDragOver = function(e) {
        if (e.dataTransfer && e.dataTransfer.items) {
          const image = [...e.dataTransfer.items].find((f) => f.kind === "file");
          return !!image;
        }
        return false;
      };
      node.onDragDrop = function(e) {
        console.log("onDragDrop called");
        let handled = false;
        for (const file of e.dataTransfer.files) {
          if (file.type.startsWith("image/")) {
            uploadFile(file, !handled);
            handled = true;
          }
        }
        return handled;
      };
      node.pasteFile = function(file) {
        if (file.type.startsWith("image/")) {
          const is_pasted = file.name === "image.png" && file.lastModified - Date.now() < 2e3;
          uploadFile(file, true, is_pasted);
          return true;
        }
        return false;
      };
      return { widget: uploadWidget };
    }
  };

  // scripts/defaultGraph.js
  var defaultGraph = {
    last_node_id: 9,
    last_link_id: 9,
    nodes: [
      {
        id: 7,
        type: "CLIPTextEncode",
        pos: [413, 389],
        size: { 0: 425.27801513671875, 1: 180.6060791015625 },
        flags: {},
        order: 3,
        mode: 0,
        inputs: [{ name: "clip", type: "CLIP", link: 5 }],
        outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [6], slot_index: 0 }],
        properties: {},
        widgets_values: ["text, watermark"]
      },
      {
        id: 6,
        type: "CLIPTextEncode",
        pos: [415, 186],
        size: { 0: 422.84503173828125, 1: 164.31304931640625 },
        flags: {},
        order: 2,
        mode: 0,
        inputs: [{ name: "clip", type: "CLIP", link: 3 }],
        outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [4], slot_index: 0 }],
        properties: {},
        widgets_values: ["beautiful scenery nature glass bottle landscape, , purple galaxy bottle,"]
      },
      {
        id: 5,
        type: "EmptyLatentImage",
        pos: [473, 609],
        size: { 0: 315, 1: 106 },
        flags: {},
        order: 1,
        mode: 0,
        outputs: [{ name: "LATENT", type: "LATENT", links: [2], slot_index: 0 }],
        properties: {},
        widgets_values: [512, 512, 1]
      },
      {
        id: 3,
        type: "KSampler",
        pos: [863, 186],
        size: { 0: 315, 1: 262 },
        flags: {},
        order: 4,
        mode: 0,
        inputs: [
          { name: "model", type: "MODEL", link: 1 },
          { name: "positive", type: "CONDITIONING", link: 4 },
          { name: "negative", type: "CONDITIONING", link: 6 },
          { name: "latent_image", type: "LATENT", link: 2 }
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: [7], slot_index: 0 }],
        properties: {},
        widgets_values: [156680208700286, true, 20, 8, "euler", "normal", 1]
      },
      {
        id: 8,
        type: "VAEDecode",
        pos: [1209, 188],
        size: { 0: 210, 1: 46 },
        flags: {},
        order: 5,
        mode: 0,
        inputs: [
          { name: "samples", type: "LATENT", link: 7 },
          { name: "vae", type: "VAE", link: 8 }
        ],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [9], slot_index: 0 }],
        properties: {}
      },
      {
        id: 9,
        type: "SaveImage",
        pos: [1451, 189],
        size: { 0: 210, 1: 26 },
        flags: {},
        order: 6,
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 9 }],
        properties: {}
      },
      {
        id: 4,
        type: "CheckpointLoaderSimple",
        pos: [26, 474],
        size: { 0: 315, 1: 98 },
        flags: {},
        order: 0,
        mode: 0,
        outputs: [
          { name: "MODEL", type: "MODEL", links: [1], slot_index: 0 },
          { name: "CLIP", type: "CLIP", links: [3, 5], slot_index: 1 },
          { name: "VAE", type: "VAE", links: [8], slot_index: 2 }
        ],
        properties: {},
        widgets_values: ["v1-5-pruned-emaonly.ckpt"]
      }
    ],
    links: [
      [1, 4, 0, 3, 0, "MODEL"],
      [2, 5, 0, 3, 3, "LATENT"],
      [3, 4, 1, 6, 0, "CLIP"],
      [4, 6, 0, 3, 1, "CONDITIONING"],
      [5, 4, 1, 7, 0, "CLIP"],
      [6, 7, 0, 3, 2, "CONDITIONING"],
      [7, 3, 0, 8, 0, "LATENT"],
      [8, 4, 2, 8, 1, "VAE"],
      [9, 8, 0, 9, 0, "IMAGE"]
    ],
    groups: [],
    config: {},
    extra: {},
    version: 0.4
  };

  // scripts/pnginfo.js
  function getPngMetadata(file) {
    return new Promise((r) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const pngData = new Uint8Array(event.target.result);
        const dataView = new DataView(pngData.buffer);
        if (dataView.getUint32(0) !== 2303741511) {
          console.error("Not a valid PNG file");
          r();
          return;
        }
        let offset = 8;
        let txt_chunks = {};
        while (offset < pngData.length) {
          const length = dataView.getUint32(offset);
          const type = String.fromCharCode(...pngData.slice(offset + 4, offset + 8));
          if (type === "tEXt" || type == "comf") {
            let keyword_end = offset + 8;
            while (pngData[keyword_end] !== 0) {
              keyword_end++;
            }
            const keyword = String.fromCharCode(...pngData.slice(offset + 8, keyword_end));
            const contentArraySegment = pngData.slice(keyword_end + 1, offset + 8 + length);
            const contentJson = Array.from(contentArraySegment).map((s) => String.fromCharCode(s)).join("");
            txt_chunks[keyword] = contentJson;
          }
          offset += 12 + length;
        }
        r(txt_chunks);
      };
      reader.readAsArrayBuffer(file);
    });
  }
  function parseExifData(exifData) {
    const isLittleEndian = new Uint16Array(exifData.slice(0, 2))[0] === 18761;
    function readInt(offset, isLittleEndian2, length) {
      let arr = exifData.slice(offset, offset + length);
      if (length === 2) {
        return new DataView(arr.buffer, arr.byteOffset, arr.byteLength).getUint16(0, isLittleEndian2);
      } else if (length === 4) {
        return new DataView(arr.buffer, arr.byteOffset, arr.byteLength).getUint32(0, isLittleEndian2);
      }
    }
    const ifdOffset = readInt(4, isLittleEndian, 4);
    function parseIFD(offset) {
      const numEntries = readInt(offset, isLittleEndian, 2);
      const result = {};
      for (let i = 0; i < numEntries; i++) {
        const entryOffset = offset + 2 + i * 12;
        const tag = readInt(entryOffset, isLittleEndian, 2);
        const type = readInt(entryOffset + 2, isLittleEndian, 2);
        const numValues = readInt(entryOffset + 4, isLittleEndian, 4);
        const valueOffset = readInt(entryOffset + 8, isLittleEndian, 4);
        let value;
        if (type === 2) {
          value = String.fromCharCode(...exifData.slice(valueOffset, valueOffset + numValues - 1));
        }
        result[tag] = value;
      }
      return result;
    }
    const ifdData = parseIFD(ifdOffset);
    return ifdData;
  }
  function getWebpMetadata(file) {
    return new Promise((r) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const webp = new Uint8Array(event.target.result);
        const dataView = new DataView(webp.buffer);
        if (dataView.getUint32(0) !== 1380533830 || dataView.getUint32(8) !== 1464156752) {
          console.error("Not a valid WEBP file");
          r();
          return;
        }
        let offset = 12;
        let txt_chunks = {};
        while (offset < webp.length) {
          const chunk_length = dataView.getUint32(offset + 4, true);
          const chunk_type = String.fromCharCode(...webp.slice(offset, offset + 4));
          if (chunk_type === "EXIF") {
            if (String.fromCharCode(...webp.slice(offset + 8, offset + 8 + 6)) == "Exif\0\0") {
              offset += 6;
            }
            let data = parseExifData(webp.slice(offset + 8, offset + 8 + chunk_length));
            for (var key in data) {
              var value = data[key];
              let index = value.indexOf(":");
              txt_chunks[value.slice(0, index)] = value.slice(index + 1);
            }
          }
          offset += 8 + chunk_length;
        }
        r(txt_chunks);
      };
      reader.readAsArrayBuffer(file);
    });
  }
  function getLatentMetadata(file) {
    return new Promise((r) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const safetensorsData = new Uint8Array(event.target.result);
        const dataView = new DataView(safetensorsData.buffer);
        let header_size = dataView.getUint32(0, true);
        let offset = 8;
        let header = JSON.parse(new TextDecoder().decode(safetensorsData.slice(offset, offset + header_size)));
        r(header.__metadata__);
      };
      var slice = file.slice(0, 1024 * 1024 * 4);
      reader.readAsArrayBuffer(slice);
    });
  }
  async function importA1111(graph2, parameters) {
    const p = parameters.lastIndexOf("\nSteps:");
    if (p > -1) {
      const embeddings = await api.getEmbeddings();
      const opts = parameters.substr(p).split("\n")[1].split(",").reduce((p3, n) => {
        const s = n.split(":");
        p3[s[0].trim().toLowerCase()] = s[1].trim();
        return p3;
      }, {});
      const p2 = parameters.lastIndexOf("\nNegative prompt:", p);
      if (p2 > -1) {
        let getWidget = function(node, name) {
          return node.widgets.find((w) => w.name === name);
        }, setWidgetValue = function(node, name, value, isOptionPrefix) {
          const w = getWidget(node, name);
          if (isOptionPrefix) {
            const o = w.options.values.find((w2) => w2.startsWith(value));
            if (o) {
              w.value = o;
            } else {
              console.warn(`Unknown value '${value}' for widget '${name}'`, node);
              w.value = value;
            }
          } else {
            w.value = value;
          }
        }, createLoraNodes = function(clipNode, text, prevClip, prevModel) {
          const loras = [];
          text = text.replace(/<lora:([^:]+:[^>]+)>/g, function(m, c) {
            const s = c.split(":");
            const weight = parseFloat(s[1]);
            if (isNaN(weight)) {
              console.warn("Invalid LORA", m);
            } else {
              loras.push({ name: s[0], weight });
            }
            return "";
          });
          for (const l of loras) {
            const loraNode = LiteGraph.createNode("LoraLoader");
            graph2.add(loraNode);
            setWidgetValue(loraNode, "lora_name", l.name, true);
            setWidgetValue(loraNode, "strength_model", l.weight);
            setWidgetValue(loraNode, "strength_clip", l.weight);
            prevModel.node.connect(prevModel.index, loraNode, 0);
            prevClip.node.connect(prevClip.index, loraNode, 1);
            prevModel = { node: loraNode, index: 0 };
            prevClip = { node: loraNode, index: 1 };
          }
          prevClip.node.connect(1, clipNode, 0);
          prevModel.node.connect(0, samplerNode, 0);
          if (hrSamplerNode) {
            prevModel.node.connect(0, hrSamplerNode, 0);
          }
          return { text, prevModel, prevClip };
        }, replaceEmbeddings = function(text) {
          if (!embeddings.length)
            return text;
          return text.replaceAll(
            new RegExp(
              "\\b(" + embeddings.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\b|\\b") + ")\\b",
              "ig"
            ),
            "embedding:$1"
          );
        }, popOpt = function(name) {
          const v = opts[name];
          delete opts[name];
          return v;
        };
        let positive = parameters.substr(0, p2).trim();
        let negative = parameters.substring(p2 + 18, p).trim();
        const ckptNode = LiteGraph.createNode("CheckpointLoaderSimple");
        const clipSkipNode = LiteGraph.createNode("CLIPSetLastLayer");
        const positiveNode = LiteGraph.createNode("CLIPTextEncode");
        const negativeNode = LiteGraph.createNode("CLIPTextEncode");
        const samplerNode = LiteGraph.createNode("KSampler");
        const imageNode = LiteGraph.createNode("EmptyLatentImage");
        const vaeNode = LiteGraph.createNode("VAEDecode");
        const vaeLoaderNode = LiteGraph.createNode("VAELoader");
        const saveNode = LiteGraph.createNode("SaveImage");
        let hrSamplerNode = null;
        const ceil64 = (v) => Math.ceil(v / 64) * 64;
        graph2.clear();
        graph2.add(ckptNode);
        graph2.add(clipSkipNode);
        graph2.add(positiveNode);
        graph2.add(negativeNode);
        graph2.add(samplerNode);
        graph2.add(imageNode);
        graph2.add(vaeNode);
        graph2.add(vaeLoaderNode);
        graph2.add(saveNode);
        ckptNode.connect(1, clipSkipNode, 0);
        clipSkipNode.connect(0, positiveNode, 0);
        clipSkipNode.connect(0, negativeNode, 0);
        ckptNode.connect(0, samplerNode, 0);
        positiveNode.connect(0, samplerNode, 1);
        negativeNode.connect(0, samplerNode, 2);
        imageNode.connect(0, samplerNode, 3);
        vaeNode.connect(0, saveNode, 0);
        samplerNode.connect(0, vaeNode, 0);
        vaeLoaderNode.connect(0, vaeNode, 1);
        const handlers = {
          model(v) {
            setWidgetValue(ckptNode, "ckpt_name", v, true);
          },
          "cfg scale"(v) {
            setWidgetValue(samplerNode, "cfg", +v);
          },
          "clip skip"(v) {
            setWidgetValue(clipSkipNode, "stop_at_clip_layer", -v);
          },
          sampler(v) {
            let name = v.toLowerCase().replace("++", "pp").replaceAll(" ", "_");
            if (name.includes("karras")) {
              name = name.replace("karras", "").replace(/_+$/, "");
              setWidgetValue(samplerNode, "scheduler", "karras");
            } else {
              setWidgetValue(samplerNode, "scheduler", "normal");
            }
            const w = getWidget(samplerNode, "sampler_name");
            const o = w.options.values.find((w2) => w2 === name || w2 === "sample_" + name);
            if (o) {
              setWidgetValue(samplerNode, "sampler_name", o);
            }
          },
          size(v) {
            const wxh = v.split("x");
            const w = ceil64(+wxh[0]);
            const h = ceil64(+wxh[1]);
            const hrUp = popOpt("hires upscale");
            const hrSz = popOpt("hires resize");
            let hrMethod = popOpt("hires upscaler");
            setWidgetValue(imageNode, "width", w);
            setWidgetValue(imageNode, "height", h);
            if (hrUp || hrSz) {
              let uw, uh;
              if (hrUp) {
                uw = w * hrUp;
                uh = h * hrUp;
              } else {
                const s = hrSz.split("x");
                uw = +s[0];
                uh = +s[1];
              }
              let upscaleNode;
              let latentNode;
              if (hrMethod.startsWith("Latent")) {
                latentNode = upscaleNode = LiteGraph.createNode("LatentUpscale");
                graph2.add(upscaleNode);
                samplerNode.connect(0, upscaleNode, 0);
                switch (hrMethod) {
                  case "Latent (nearest-exact)":
                    hrMethod = "nearest-exact";
                    break;
                }
                setWidgetValue(upscaleNode, "upscale_method", hrMethod, true);
              } else {
                const decode = LiteGraph.createNode("VAEDecodeTiled");
                graph2.add(decode);
                samplerNode.connect(0, decode, 0);
                vaeLoaderNode.connect(0, decode, 1);
                const upscaleLoaderNode = LiteGraph.createNode("UpscaleModelLoader");
                graph2.add(upscaleLoaderNode);
                setWidgetValue(upscaleLoaderNode, "model_name", hrMethod, true);
                const modelUpscaleNode = LiteGraph.createNode("ImageUpscaleWithModel");
                graph2.add(modelUpscaleNode);
                decode.connect(0, modelUpscaleNode, 1);
                upscaleLoaderNode.connect(0, modelUpscaleNode, 0);
                upscaleNode = LiteGraph.createNode("ImageScale");
                graph2.add(upscaleNode);
                modelUpscaleNode.connect(0, upscaleNode, 0);
                const vaeEncodeNode = latentNode = LiteGraph.createNode("VAEEncodeTiled");
                graph2.add(vaeEncodeNode);
                upscaleNode.connect(0, vaeEncodeNode, 0);
                vaeLoaderNode.connect(0, vaeEncodeNode, 1);
              }
              setWidgetValue(upscaleNode, "width", ceil64(uw));
              setWidgetValue(upscaleNode, "height", ceil64(uh));
              hrSamplerNode = LiteGraph.createNode("KSampler");
              graph2.add(hrSamplerNode);
              ckptNode.connect(0, hrSamplerNode, 0);
              positiveNode.connect(0, hrSamplerNode, 1);
              negativeNode.connect(0, hrSamplerNode, 2);
              latentNode.connect(0, hrSamplerNode, 3);
              hrSamplerNode.connect(0, vaeNode, 0);
            }
          },
          steps(v) {
            setWidgetValue(samplerNode, "steps", +v);
          },
          seed(v) {
            setWidgetValue(samplerNode, "seed", +v);
          }
        };
        for (const opt in opts) {
          if (opt in handlers) {
            handlers[opt](popOpt(opt));
          }
        }
        if (hrSamplerNode) {
          setWidgetValue(hrSamplerNode, "steps", getWidget(samplerNode, "steps").value);
          setWidgetValue(hrSamplerNode, "cfg", getWidget(samplerNode, "cfg").value);
          setWidgetValue(hrSamplerNode, "scheduler", getWidget(samplerNode, "scheduler").value);
          setWidgetValue(hrSamplerNode, "sampler_name", getWidget(samplerNode, "sampler_name").value);
          setWidgetValue(hrSamplerNode, "denoise", +(popOpt("denoising strength") || "1"));
        }
        let n = createLoraNodes(positiveNode, positive, { node: clipSkipNode, index: 0 }, { node: ckptNode, index: 0 });
        positive = n.text;
        n = createLoraNodes(negativeNode, negative, n.prevClip, n.prevModel);
        negative = n.text;
        setWidgetValue(positiveNode, "text", replaceEmbeddings(positive));
        setWidgetValue(negativeNode, "text", replaceEmbeddings(negative));
        graph2.arrange();
        for (const opt of ["model hash", "ensd"]) {
          delete opts[opt];
        }
        console.warn("Unhandled parameters:", opts);
      }
    }
  }

  // scripts/ui/imagePreview.js
  function calculateImageGrid(imgs, dw, dh) {
    let best = 0;
    let w = imgs[0].naturalWidth;
    let h = imgs[0].naturalHeight;
    const numImages = imgs.length;
    let cellWidth, cellHeight, cols, rows, shiftX;
    for (let c = 1; c <= numImages; c++) {
      const r = Math.ceil(numImages / c);
      const cW = dw / c;
      const cH = dh / r;
      const scaleX = cW / w;
      const scaleY = cH / h;
      const scale = Math.min(scaleX, scaleY, 1);
      const imageW = w * scale;
      const imageH = h * scale;
      const area = imageW * imageH * numImages;
      if (area > best) {
        best = area;
        cellWidth = imageW;
        cellHeight = imageH;
        cols = c;
        rows = r;
        shiftX = c * ((cW - imageW) / 2);
      }
    }
    return { cellWidth, cellHeight, cols, rows, shiftX };
  }
  function createImageHost(node) {
    const el = $el("div.comfy-img-preview");
    let currentImgs;
    let first = true;
    function updateSize() {
      let w = null;
      let h = null;
      if (currentImgs) {
        let elH = el.clientHeight;
        if (first) {
          first = false;
          if (elH < 190) {
            elH = 190;
          }
          el.style.setProperty("--comfy-widget-min-height", elH);
        } else {
          el.style.setProperty("--comfy-widget-min-height", null);
        }
        const nw = node.size[0];
        ({ cellWidth: w, cellHeight: h } = calculateImageGrid(currentImgs, nw - 20, elH));
        w += "px";
        h += "px";
        el.style.setProperty("--comfy-img-preview-width", w);
        el.style.setProperty("--comfy-img-preview-height", h);
      }
    }
    return {
      el,
      updateImages(imgs) {
        if (imgs !== currentImgs) {
          if (currentImgs == null) {
            requestAnimationFrame(() => {
              updateSize();
            });
          }
          el.replaceChildren(...imgs);
          currentImgs = imgs;
          node.onResize(node.size);
          node.graph.setDirtyCanvas(true, true);
        }
      },
      getHeight() {
        updateSize();
      },
      onDraw() {
        el.style.pointerEvents = "all";
        const over = document.elementFromPoint(app.canvas.mouse[0], app.canvas.mouse[1]);
        el.style.pointerEvents = "none";
        if (!over)
          return;
        const idx = currentImgs.indexOf(over);
        node.overIndex = idx;
      }
    };
  }

  // scripts/app.js
  var ANIM_PREVIEW_WIDGET = "$$comfy_animation_preview";
  function sanitizeNodeName(string) {
    let entityMap = {
      "&": "",
      "<": "",
      ">": "",
      '"': "",
      "'": "",
      "`": "",
      "=": ""
    };
    return String(string).replace(/[&<>"'`=]/g, function fromEntityMap(s) {
      return entityMap[s];
    });
  }
  var ComfyApp = class _ComfyApp {
    /**
     * List of entries to queue
     * @type {{number: number, batchCount: number}[]}
     */
    #queueItems = [];
    /**
     * If the queue is currently being processed
     * @type {boolean}
     */
    #processingQueue = false;
    /**
     * Content Clipboard
     * @type {serialized node object}
     */
    static clipspace = null;
    static clipspace_invalidate_handler = null;
    static open_maskeditor = null;
    static clipspace_return_node = null;
    constructor() {
      this.ui = new ComfyUI(this);
      this.logging = new ComfyLogging(this);
      this.extensions = [];
      this.nodeOutputs = {};
      this.nodePreviewImages = {};
      this.shiftDown = false;
    }
    getPreviewFormatParam() {
      let preview_format = this.ui.settings.getSettingValue("Comfy.PreviewFormat");
      if (preview_format)
        return `&preview=${preview_format}`;
      else
        return "";
    }
    static isImageNode(node) {
      return node.imgs || node && node.widgets && node.widgets.findIndex((obj) => obj.name === "image") >= 0;
    }
    static onClipspaceEditorSave() {
      if (_ComfyApp.clipspace_return_node) {
        _ComfyApp.pasteFromClipspace(_ComfyApp.clipspace_return_node);
      }
    }
    static onClipspaceEditorClosed() {
      _ComfyApp.clipspace_return_node = null;
    }
    static copyToClipspace(node) {
      var widgets = null;
      if (node.widgets) {
        widgets = node.widgets.map(({ type, name, value }) => ({ type, name, value }));
      }
      var imgs = void 0;
      var orig_imgs = void 0;
      if (node.imgs != void 0) {
        imgs = [];
        orig_imgs = [];
        for (let i = 0; i < node.imgs.length; i++) {
          imgs[i] = new Image();
          imgs[i].src = node.imgs[i].src;
          orig_imgs[i] = imgs[i];
        }
      }
      var selectedIndex = 0;
      if (node.imageIndex) {
        selectedIndex = node.imageIndex;
      }
      _ComfyApp.clipspace = {
        "widgets": widgets,
        "imgs": imgs,
        "original_imgs": orig_imgs,
        "images": node.images,
        "selectedIndex": selectedIndex,
        "img_paste_mode": "selected"
        // reset to default im_paste_mode state on copy action
      };
      _ComfyApp.clipspace_return_node = null;
      if (_ComfyApp.clipspace_invalidate_handler) {
        _ComfyApp.clipspace_invalidate_handler();
      }
    }
    static pasteFromClipspace(node) {
      if (_ComfyApp.clipspace) {
        if (_ComfyApp.clipspace.imgs && node.imgs) {
          if (node.images && _ComfyApp.clipspace.images) {
            if (_ComfyApp.clipspace["img_paste_mode"] == "selected") {
              node.images = [_ComfyApp.clipspace.images[_ComfyApp.clipspace["selectedIndex"]]];
            } else {
              node.images = _ComfyApp.clipspace.images;
            }
            if (app2.nodeOutputs[node.id + ""])
              app2.nodeOutputs[node.id + ""].images = node.images;
          }
          if (_ComfyApp.clipspace.imgs) {
            if (_ComfyApp.clipspace["img_paste_mode"] == "selected") {
              const img = new Image();
              img.src = _ComfyApp.clipspace.imgs[_ComfyApp.clipspace["selectedIndex"]].src;
              node.imgs = [img];
              node.imageIndex = 0;
            } else {
              const imgs = [];
              for (let i = 0; i < _ComfyApp.clipspace.imgs.length; i++) {
                imgs[i] = new Image();
                imgs[i].src = _ComfyApp.clipspace.imgs[i].src;
                node.imgs = imgs;
              }
            }
          }
        }
        if (node.widgets) {
          if (_ComfyApp.clipspace.images) {
            const clip_image = _ComfyApp.clipspace.images[_ComfyApp.clipspace["selectedIndex"]];
            const index = node.widgets.findIndex((obj) => obj.name === "image");
            if (index >= 0) {
              if (node.widgets[index].type != "image" && typeof node.widgets[index].value == "string" && clip_image.filename) {
                node.widgets[index].value = (clip_image.subfolder ? clip_image.subfolder + "/" : "") + clip_image.filename + (clip_image.type ? ` [${clip_image.type}]` : "");
              } else {
                node.widgets[index].value = clip_image;
              }
            }
          }
          if (_ComfyApp.clipspace.widgets) {
            _ComfyApp.clipspace.widgets.forEach(({ type, name, value }) => {
              const prop = Object.values(node.widgets).find((obj) => obj.type === type && obj.name === name);
              if (prop && prop.type != "button") {
                if (prop.type != "image" && typeof prop.value == "string" && value.filename) {
                  prop.value = (value.subfolder ? value.subfolder + "/" : "") + value.filename + (value.type ? ` [${value.type}]` : "");
                } else {
                  prop.value = value;
                  prop.callback(value);
                }
              }
            });
          }
        }
        app2.graph.setDirtyCanvas(true);
      }
    }
    /**
     * Invoke an extension callback
     * @param {keyof ComfyExtension} method The extension callback to execute
     * @param  {any[]} args Any arguments to pass to the callback
     * @returns
     */
    #invokeExtensions(method, ...args) {
      let results = [];
      for (const ext of this.extensions) {
        if (method in ext) {
          try {
            results.push(ext[method](...args, this));
          } catch (error) {
            console.error(
              `Error calling extension '${ext.name}' method '${method}'`,
              { error },
              { extension: ext },
              { args }
            );
          }
        }
      }
      return results;
    }
    /**
     * Invoke an async extension callback
     * Each callback will be invoked concurrently
     * @param {string} method The extension callback to execute
     * @param  {...any} args Any arguments to pass to the callback
     * @returns
     */
    async #invokeExtensionsAsync(method, ...args) {
      return await Promise.all(
        this.extensions.map(async (ext) => {
          if (method in ext) {
            try {
              return await ext[method](...args, this);
            } catch (error) {
              console.error(
                `Error calling extension '${ext.name}' method '${method}'`,
                { error },
                { extension: ext },
                { args }
              );
            }
          }
        })
      );
    }
    /**
     * Adds special context menu handling for nodes
     * e.g. this adds Open Image functionality for nodes that show images
     * @param {*} node The node to add the menu handler
     */
    #addNodeContextMenuHandler(node) {
      node.prototype.getExtraMenuOptions = function(_, options) {
        if (this.imgs) {
          let img;
          if (this.imageIndex != null) {
            img = this.imgs[this.imageIndex];
          } else if (this.overIndex != null) {
            img = this.imgs[this.overIndex];
          }
          if (img) {
            options.unshift(
              {
                content: "Open Image",
                callback: () => {
                  let url = new URL(img.src);
                  url.searchParams.delete("preview");
                  window.open(url, "_blank");
                }
              },
              {
                content: "Save Image",
                callback: () => {
                  const a = document.createElement("a");
                  let url = new URL(img.src);
                  url.searchParams.delete("preview");
                  a.href = url;
                  a.setAttribute("download", new URLSearchParams(url.search).get("filename"));
                  document.body.append(a);
                  a.click();
                  requestAnimationFrame(() => a.remove());
                }
              }
            );
          }
        }
        options.push({
          content: "Bypass",
          callback: (obj) => {
            if (this.mode === 4)
              this.mode = 0;
            else
              this.mode = 4;
            this.graph.change();
          }
        });
        if (!_ComfyApp.clipspace_return_node) {
          options.push({
            content: "Copy (Clipspace)",
            callback: (obj) => {
              _ComfyApp.copyToClipspace(this);
            }
          });
          if (_ComfyApp.clipspace != null) {
            options.push({
              content: "Paste (Clipspace)",
              callback: () => {
                _ComfyApp.pasteFromClipspace(this);
              }
            });
          }
          if (_ComfyApp.isImageNode(this)) {
            options.push({
              content: "Open in MaskEditor",
              callback: (obj) => {
                _ComfyApp.copyToClipspace(this);
                _ComfyApp.clipspace_return_node = this;
                _ComfyApp.open_maskeditor();
              }
            });
          }
        }
      };
    }
    #addNodeKeyHandler(node) {
      const app3 = this;
      const origNodeOnKeyDown = node.prototype.onKeyDown;
      node.prototype.onKeyDown = function(e) {
        if (origNodeOnKeyDown && origNodeOnKeyDown.apply(this, e) === false) {
          return false;
        }
        if (this.flags.collapsed || !this.imgs || this.imageIndex === null) {
          return;
        }
        let handled = false;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          if (e.key === "ArrowLeft") {
            this.imageIndex -= 1;
          } else if (e.key === "ArrowRight") {
            this.imageIndex += 1;
          }
          this.imageIndex %= this.imgs.length;
          if (this.imageIndex < 0) {
            this.imageIndex = this.imgs.length + this.imageIndex;
          }
          handled = true;
        } else if (e.key === "Escape") {
          this.imageIndex = null;
          handled = true;
        }
        if (handled === true) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return false;
        }
      };
    }
    /**
     * Adds Custom drawing logic for nodes
     * e.g. Draws images and handles thumbnail navigation on nodes that output images
     * @param {*} node The node to add the draw handler
     */
    #addDrawBackgroundHandler(node) {
      const app3 = this;
      function getImageTop(node2) {
        let shiftY;
        if (node2.imageOffset != null) {
          shiftY = node2.imageOffset;
        } else {
          if (node2.widgets?.length) {
            const w = node2.widgets[node2.widgets.length - 1];
            shiftY = w.last_y;
            if (w.computeSize) {
              shiftY += w.computeSize()[1] + 4;
            } else if (w.computedHeight) {
              shiftY += w.computedHeight;
            } else {
              shiftY += LiteGraph.NODE_WIDGET_HEIGHT + 4;
            }
          } else {
            shiftY = node2.computeSize()[1];
          }
        }
        return shiftY;
      }
      node.prototype.setSizeForImage = function(force) {
        if (!force && this.animatedImages)
          return;
        if (this.inputHeight) {
          this.setSize(this.size);
          return;
        }
        const minHeight = getImageTop(this) + 220;
        if (this.size[1] < minHeight) {
          this.setSize([this.size[0], minHeight]);
        }
      };
      node.prototype.onDrawBackground = function(ctx) {
        if (!this.flags.collapsed) {
          let calculateGrid = function(w, h, n) {
            let columns, rows, cellsize;
            if (w > h) {
              cellsize = h;
              columns = Math.ceil(w / cellsize);
              rows = Math.ceil(n / columns);
            } else {
              cellsize = w;
              rows = Math.ceil(h / cellsize);
              columns = Math.ceil(n / rows);
            }
            while (columns * rows < n) {
              cellsize++;
              if (w >= h) {
                columns = Math.ceil(w / cellsize);
                rows = Math.ceil(n / columns);
              } else {
                rows = Math.ceil(h / cellsize);
                columns = Math.ceil(n / rows);
              }
            }
            const cell_size = Math.min(w / columns, h / rows);
            return { cell_size, columns, rows };
          }, is_all_same_aspect_ratio = function(imgs) {
            let ratio2 = imgs[0].naturalWidth / imgs[0].naturalHeight;
            for (let i = 1; i < imgs.length; i++) {
              let this_ratio = imgs[i].naturalWidth / imgs[i].naturalHeight;
              if (ratio2 != this_ratio)
                return false;
            }
            return true;
          };
          let imgURLs = [];
          let imagesChanged = false;
          const output = app3.nodeOutputs[this.id + ""];
          if (output?.images) {
            this.animatedImages = output?.animated?.find(Boolean);
            if (this.images !== output.images) {
              this.images = output.images;
              imagesChanged = true;
              imgURLs = imgURLs.concat(
                output.images.map((params) => {
                  return api.apiURL(
                    "/view?" + new URLSearchParams(params).toString() + (this.animatedImages ? "" : app3.getPreviewFormatParam())
                  );
                })
              );
            }
          }
          const preview = app3.nodePreviewImages[this.id + ""];
          if (this.preview !== preview) {
            this.preview = preview;
            imagesChanged = true;
            if (preview != null) {
              imgURLs.push(preview);
            }
          }
          if (imagesChanged) {
            this.imageIndex = null;
            if (imgURLs.length > 0) {
              Promise.all(
                imgURLs.map((src) => {
                  return new Promise((r) => {
                    const img = new Image();
                    img.onload = () => r(img);
                    img.onerror = () => r(null);
                    img.src = src;
                  });
                })
              ).then((imgs) => {
                if ((!output || this.images === output.images) && (!preview || this.preview === preview)) {
                  this.imgs = imgs.filter(Boolean);
                  this.setSizeForImage?.();
                  app3.graph.setDirtyCanvas(true);
                }
              });
            } else {
              this.imgs = null;
            }
          }
          if (this.imgs?.length) {
            const widgetIdx = this.widgets?.findIndex((w) => w.name === ANIM_PREVIEW_WIDGET);
            if (this.animatedImages) {
              if (widgetIdx > -1) {
                const widget = this.widgets[widgetIdx];
                widget.options.host.updateImages(this.imgs);
              } else {
                const host = createImageHost(this);
                this.setSizeForImage(true);
                const widget = this.addDOMWidget(ANIM_PREVIEW_WIDGET, "img", host.el, {
                  host,
                  getHeight: host.getHeight,
                  onDraw: host.onDraw,
                  hideOnZoom: false
                });
                widget.serializeValue = () => void 0;
                widget.options.host.updateImages(this.imgs);
              }
              return;
            }
            if (widgetIdx > -1) {
              this.widgets[widgetIdx].onRemove?.();
              this.widgets.splice(widgetIdx, 1);
            }
            const canvas = app3.graph.list_of_graphcanvas[0];
            const mouse = canvas.graph_mouse;
            if (!canvas.pointer_is_down && this.pointerDown) {
              if (mouse[0] === this.pointerDown.pos[0] && mouse[1] === this.pointerDown.pos[1]) {
                this.imageIndex = this.pointerDown.index;
              }
              this.pointerDown = null;
            }
            let imageIndex = this.imageIndex;
            const numImages = this.imgs.length;
            if (numImages === 1 && !imageIndex) {
              this.imageIndex = imageIndex = 0;
            }
            const top = getImageTop(this);
            var shiftY = top;
            let dw = this.size[0];
            let dh = this.size[1];
            dh -= shiftY;
            if (imageIndex == null) {
              var cellWidth, cellHeight, shiftX, cell_padding, cols;
              const compact_mode = is_all_same_aspect_ratio(this.imgs);
              if (!compact_mode) {
                cell_padding = 2;
                const { cell_size, columns, rows } = calculateGrid(dw, dh, numImages);
                cols = columns;
                cellWidth = cell_size;
                cellHeight = cell_size;
                shiftX = (dw - cell_size * cols) / 2;
                shiftY = (dh - cell_size * rows) / 2 + top;
              } else {
                cell_padding = 0;
                ({ cellWidth, cellHeight, cols, shiftX } = calculateImageGrid(this.imgs, dw, dh));
              }
              let anyHovered = false;
              this.imageRects = [];
              for (let i = 0; i < numImages; i++) {
                const img = this.imgs[i];
                const row = Math.floor(i / cols);
                const col = i % cols;
                const x = col * cellWidth + shiftX;
                const y = row * cellHeight + shiftY;
                if (!anyHovered) {
                  anyHovered = LiteGraph.isInsideRectangle(
                    mouse[0],
                    mouse[1],
                    x + this.pos[0],
                    y + this.pos[1],
                    cellWidth,
                    cellHeight
                  );
                  if (anyHovered) {
                    this.overIndex = i;
                    let value = 110;
                    if (canvas.pointer_is_down) {
                      if (!this.pointerDown || this.pointerDown.index !== i) {
                        this.pointerDown = { index: i, pos: [...mouse] };
                      }
                      value = 125;
                    }
                    ctx.filter = `contrast(${value}%) brightness(${value}%)`;
                    canvas.canvas.style.cursor = "pointer";
                  }
                }
                this.imageRects.push([x, y, cellWidth, cellHeight]);
                let wratio = cellWidth / img.width;
                let hratio = cellHeight / img.height;
                var ratio = Math.min(wratio, hratio);
                let imgHeight = ratio * img.height;
                let imgY = row * cellHeight + shiftY + (cellHeight - imgHeight) / 2;
                let imgWidth = ratio * img.width;
                let imgX = col * cellWidth + shiftX + (cellWidth - imgWidth) / 2;
                ctx.drawImage(img, imgX + cell_padding, imgY + cell_padding, imgWidth - cell_padding * 2, imgHeight - cell_padding * 2);
                if (!compact_mode) {
                  ctx.strokeStyle = "#8F8F8F";
                  ctx.lineWidth = 1;
                  ctx.strokeRect(x + cell_padding, y + cell_padding, cellWidth - cell_padding * 2, cellHeight - cell_padding * 2);
                }
                ctx.filter = "none";
              }
              if (!anyHovered) {
                this.pointerDown = null;
                this.overIndex = null;
              }
            } else {
              let w = this.imgs[imageIndex].naturalWidth;
              let h = this.imgs[imageIndex].naturalHeight;
              const scaleX = dw / w;
              const scaleY = dh / h;
              const scale = Math.min(scaleX, scaleY, 1);
              w *= scale;
              h *= scale;
              let x = (dw - w) / 2;
              let y = (dh - h) / 2 + shiftY;
              ctx.drawImage(this.imgs[imageIndex], x, y, w, h);
              const drawButton = (x2, y2, sz, text) => {
                const hovered = LiteGraph.isInsideRectangle(mouse[0], mouse[1], x2 + this.pos[0], y2 + this.pos[1], sz, sz);
                let fill = "#333";
                let textFill = "#fff";
                let isClicking = false;
                if (hovered) {
                  canvas.canvas.style.cursor = "pointer";
                  if (canvas.pointer_is_down) {
                    fill = "#1e90ff";
                    isClicking = true;
                  } else {
                    fill = "#eee";
                    textFill = "#000";
                  }
                } else {
                  this.pointerWasDown = null;
                }
                ctx.fillStyle = fill;
                ctx.beginPath();
                ctx.roundRect(x2, y2, sz, sz, [4]);
                ctx.fill();
                ctx.fillStyle = textFill;
                ctx.font = "12px Arial";
                ctx.textAlign = "center";
                ctx.fillText(text, x2 + 15, y2 + 20);
                return isClicking;
              };
              if (numImages > 1) {
                if (drawButton(dw - 40, dh + top - 40, 30, `${this.imageIndex + 1}/${numImages}`)) {
                  let i = this.imageIndex + 1 >= numImages ? 0 : this.imageIndex + 1;
                  if (!this.pointerDown || !this.pointerDown.index === i) {
                    this.pointerDown = { index: i, pos: [...mouse] };
                  }
                }
                if (drawButton(dw - 40, top + 10, 30, `x`)) {
                  if (!this.pointerDown || !this.pointerDown.index === null) {
                    this.pointerDown = { index: null, pos: [...mouse] };
                  }
                }
              }
            }
          }
        }
      };
    }
    /**
     * Adds a handler allowing drag+drop of files onto the window to load workflows
     */
    #addDropHandler() {
      document.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const n = this.dragOverNode;
        this.dragOverNode = null;
        if (n && n.onDragDrop && await n.onDragDrop(event)) {
          return;
        }
        if (event.dataTransfer.files.length && event.dataTransfer.files[0].type !== "image/bmp") {
          await this.handleFile(event.dataTransfer.files[0]);
        } else {
          const validTypes = ["text/uri-list", "text/x-moz-url"];
          const match = [...event.dataTransfer.types].find((t) => validTypes.find((v) => t === v));
          if (match) {
            const uri = event.dataTransfer.getData(match)?.split("\n")?.[0];
            if (uri) {
              await this.handleFile(await (await fetch(uri)).blob());
            }
          }
        }
      });
      this.canvasEl.addEventListener("dragleave", async () => {
        if (this.dragOverNode) {
          this.dragOverNode = null;
          this.graph.setDirtyCanvas(false, true);
        }
      });
      this.canvasEl.addEventListener(
        "dragover",
        (e) => {
          this.canvas.adjustMouseEvent(e);
          const node = this.graph.getNodeOnPos(e.canvasX, e.canvasY);
          if (node) {
            if (node.onDragOver && node.onDragOver(e)) {
              this.dragOverNode = node;
              requestAnimationFrame(() => {
                this.graph.setDirtyCanvas(false, true);
              });
              return;
            }
          }
          this.dragOverNode = null;
        },
        false
      );
    }
    /**
     * Adds a handler on paste that extracts and loads images or workflows from pasted JSON data
     */
    #addPasteHandler() {
      document.addEventListener("paste", (e) => {
        if (this.shiftDown)
          return;
        let data = e.clipboardData || window.clipboardData;
        const items = data.items;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            var imageNode = null;
            if (this.canvas.current_node && this.canvas.current_node.is_selected && _ComfyApp.isImageNode(this.canvas.current_node)) {
              imageNode = this.canvas.current_node;
            }
            if (!imageNode) {
              const newNode = LiteGraph.createNode("LoadImage");
              newNode.pos = [...this.canvas.graph_mouse];
              imageNode = this.graph.add(newNode);
              this.graph.change();
            }
            const blob = item.getAsFile();
            imageNode.pasteFile(blob);
            return;
          }
        }
        data = data.getData("text/plain");
        let workflow;
        try {
          data = data.slice(data.indexOf("{"));
          workflow = JSON.parse(data);
        } catch (err) {
          try {
            data = data.slice(data.indexOf("workflow\n"));
            data = data.slice(data.indexOf("{"));
            workflow = JSON.parse(data);
          } catch (error) {
          }
        }
        if (workflow && workflow.version && workflow.nodes && workflow.extra) {
          this.loadGraphData(workflow);
        } else {
          if (e.target.type === "text" || e.target.type === "textarea") {
            return;
          }
          this.canvas.pasteFromClipboard();
        }
      });
    }
    /**
     * Adds a handler on copy that serializes selected nodes to JSON
     */
    #addCopyHandler() {
      document.addEventListener("copy", (e) => {
        if (e.target.type === "text" || e.target.type === "textarea") {
          return;
        }
        if (e.target.className === "litegraph" && this.canvas.selected_nodes) {
          this.canvas.copyToClipboard();
          e.clipboardData.setData("text", " ");
          e.preventDefault();
          e.stopImmediatePropagation();
          return false;
        }
      });
    }
    /**
     * Handle mouse
     *
     * Move group by header
     */
    #addProcessMouseHandler() {
      const self = this;
      const origProcessMouseDown = LGraphCanvas.prototype.processMouseDown;
      LGraphCanvas.prototype.processMouseDown = function(e) {
        const res = origProcessMouseDown.apply(this, arguments);
        this.selected_group_moving = false;
        if (this.selected_group && !this.selected_group_resizing) {
          var font_size = this.selected_group.font_size || LiteGraph.DEFAULT_GROUP_FONT_SIZE;
          var height = font_size * 1.4;
          if (LiteGraph.isInsideRectangle(e.canvasX, e.canvasY, this.selected_group.pos[0], this.selected_group.pos[1], this.selected_group.size[0], height)) {
            this.selected_group_moving = true;
          }
        }
        return res;
      };
      const origProcessMouseMove = LGraphCanvas.prototype.processMouseMove;
      LGraphCanvas.prototype.processMouseMove = function(e) {
        const orig_selected_group = this.selected_group;
        if (this.selected_group && !this.selected_group_resizing && !this.selected_group_moving) {
          this.selected_group = null;
        }
        const res = origProcessMouseMove.apply(this, arguments);
        if (orig_selected_group && !this.selected_group_resizing && !this.selected_group_moving) {
          this.selected_group = orig_selected_group;
        }
        return res;
      };
    }
    /**
     * Handle keypress
     *
     * Ctrl + M mute/unmute selected nodes
     */
    #addProcessKeyHandler() {
      const self = this;
      const origProcessKey = LGraphCanvas.prototype.processKey;
      LGraphCanvas.prototype.processKey = function(e) {
        if (!this.graph) {
          return;
        }
        var block_default = false;
        if (e.target.localName == "input") {
          return;
        }
        if (e.type == "keydown" && !e.repeat) {
          if (e.key === "m" && e.ctrlKey) {
            if (this.selected_nodes) {
              for (var i in this.selected_nodes) {
                if (this.selected_nodes[i].mode === 2) {
                  this.selected_nodes[i].mode = 0;
                } else {
                  this.selected_nodes[i].mode = 2;
                }
              }
            }
            block_default = true;
          }
          if (e.key === "b" && e.ctrlKey) {
            if (this.selected_nodes) {
              for (var i in this.selected_nodes) {
                if (this.selected_nodes[i].mode === 4) {
                  this.selected_nodes[i].mode = 0;
                } else {
                  this.selected_nodes[i].mode = 4;
                }
              }
            }
            block_default = true;
          }
          if (e.key === "c" && e.altKey) {
            if (this.selected_nodes) {
              for (var i in this.selected_nodes) {
                this.selected_nodes[i].collapse();
              }
            }
            block_default = true;
          }
          if (e.key === "c" && (e.metaKey || e.ctrlKey)) {
            return true;
          }
          if ((e.key === "v" || e.key == "V") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
            return true;
          }
        }
        this.graph.change();
        if (block_default) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return false;
        }
        return origProcessKey.apply(this, arguments);
      };
    }
    /**
     * Draws group header bar
     */
    #addDrawGroupsHandler() {
      const self = this;
      const origDrawGroups = LGraphCanvas.prototype.drawGroups;
      LGraphCanvas.prototype.drawGroups = function(canvas, ctx) {
        if (!this.graph) {
          return;
        }
        var groups = this.graph._groups;
        ctx.save();
        ctx.globalAlpha = 0.7 * this.editor_alpha;
        for (var i = 0; i < groups.length; ++i) {
          var group = groups[i];
          if (!LiteGraph.overlapBounding(this.visible_area, group._bounding)) {
            continue;
          }
          ctx.fillStyle = group.color || "#335";
          ctx.strokeStyle = group.color || "#335";
          var pos = group._pos;
          var size = group._size;
          ctx.globalAlpha = 0.25 * this.editor_alpha;
          ctx.beginPath();
          var font_size = group.font_size || LiteGraph.DEFAULT_GROUP_FONT_SIZE;
          ctx.rect(pos[0] + 0.5, pos[1] + 0.5, size[0], font_size * 1.4);
          ctx.fill();
          ctx.globalAlpha = this.editor_alpha;
        }
        ctx.restore();
        const res = origDrawGroups.apply(this, arguments);
        return res;
      };
    }
    /**
     * Draws node highlights (executing, drag drop) and progress bar
     */
    #addDrawNodeHandler() {
      const origDrawNodeShape = LGraphCanvas.prototype.drawNodeShape;
      const self = this;
      LGraphCanvas.prototype.drawNodeShape = function(node, ctx, size, fgcolor, bgcolor, selected, mouse_over) {
        const res = origDrawNodeShape.apply(this, arguments);
        const nodeErrors = self.lastNodeErrors?.[node.id];
        let color = null;
        let lineWidth = 1;
        if (node.id === +self.runningNodeId) {
          color = "#0f0";
        } else if (self.dragOverNode && node.id === self.dragOverNode.id) {
          color = "dodgerblue";
        } else if (nodeErrors?.errors) {
          color = "red";
          lineWidth = 2;
        } else if (self.lastExecutionError && +self.lastExecutionError.node_id === node.id) {
          color = "#f0f";
          lineWidth = 2;
        }
        if (color) {
          const shape = node._shape || node.constructor.shape || LiteGraph.ROUND_SHAPE;
          ctx.lineWidth = lineWidth;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          if (shape == LiteGraph.BOX_SHAPE)
            ctx.rect(-6, -6 - LiteGraph.NODE_TITLE_HEIGHT, 12 + size[0] + 1, 12 + size[1] + LiteGraph.NODE_TITLE_HEIGHT);
          else if (shape == LiteGraph.ROUND_SHAPE || shape == LiteGraph.CARD_SHAPE && node.flags.collapsed)
            ctx.roundRect(
              -6,
              -6 - LiteGraph.NODE_TITLE_HEIGHT,
              12 + size[0] + 1,
              12 + size[1] + LiteGraph.NODE_TITLE_HEIGHT,
              this.round_radius * 2
            );
          else if (shape == LiteGraph.CARD_SHAPE)
            ctx.roundRect(
              -6,
              -6 - LiteGraph.NODE_TITLE_HEIGHT,
              12 + size[0] + 1,
              12 + size[1] + LiteGraph.NODE_TITLE_HEIGHT,
              [this.round_radius * 2, this.round_radius * 2, 2, 2]
            );
          else if (shape == LiteGraph.CIRCLE_SHAPE)
            ctx.arc(size[0] * 0.5, size[1] * 0.5, size[0] * 0.5 + 6, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.stroke();
          ctx.strokeStyle = fgcolor;
          ctx.globalAlpha = 1;
        }
        if (self.progress && node.id === +self.runningNodeId) {
          ctx.fillStyle = "green";
          ctx.fillRect(0, 0, size[0] * (self.progress.value / self.progress.max), 6);
          ctx.fillStyle = bgcolor;
        }
        if (nodeErrors) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = "red";
          for (const error of nodeErrors.errors) {
            if (error.extra_info && error.extra_info.input_name) {
              const inputIndex = node.findInputSlot(error.extra_info.input_name);
              if (inputIndex !== -1) {
                let pos = node.getConnectionPos(true, inputIndex);
                ctx.beginPath();
                ctx.arc(pos[0] - node.pos[0], pos[1] - node.pos[1], 12, 0, 2 * Math.PI, false);
                ctx.stroke();
              }
            }
          }
        }
        return res;
      };
      const origDrawNode = LGraphCanvas.prototype.drawNode;
      LGraphCanvas.prototype.drawNode = function(node, ctx) {
        var editor_alpha = this.editor_alpha;
        var old_color = node.bgcolor;
        if (node.mode === 2) {
          this.editor_alpha = 0.4;
        }
        if (node.mode === 4) {
          node.bgcolor = "#FF00FF";
          this.editor_alpha = 0.2;
        }
        const res = origDrawNode.apply(this, arguments);
        this.editor_alpha = editor_alpha;
        node.bgcolor = old_color;
        return res;
      };
    }
    /**
     * Handles updates from the API socket
     */
    #addApiUpdateHandlers() {
      api.addEventListener("status", ({ detail }) => {
        this.ui.setStatus(detail);
      });
      api.addEventListener("reconnecting", () => {
        this.ui.dialog.show("Reconnecting...");
      });
      api.addEventListener("reconnected", () => {
        this.ui.dialog.close();
      });
      api.addEventListener("progress", ({ detail }) => {
        this.progress = detail;
        this.graph.setDirtyCanvas(true, false);
      });
      api.addEventListener("executing", ({ detail }) => {
        this.progress = null;
        this.runningNodeId = detail;
        this.graph.setDirtyCanvas(true, false);
        delete this.nodePreviewImages[this.runningNodeId];
      });
      api.addEventListener("executed", ({ detail }) => {
        this.nodeOutputs[detail.node] = detail.output;
        const node = this.graph.getNodeById(detail.node);
        if (node) {
          if (node.onExecuted)
            node.onExecuted(detail.output);
        }
      });
      api.addEventListener("execution_start", ({ detail }) => {
        this.runningNodeId = null;
        this.lastExecutionError = null;
        this.graph._nodes.forEach((node) => {
          if (node.onExecutionStart)
            node.onExecutionStart();
        });
      });
      api.addEventListener("execution_error", ({ detail }) => {
        this.lastExecutionError = detail;
        const formattedError = this.#formatExecutionError(detail);
        this.ui.dialog.show(formattedError);
        this.canvas.draw(true, true);
      });
      api.addEventListener("b_preview", ({ detail }) => {
        const id = this.runningNodeId;
        if (id == null)
          return;
        const blob = detail;
        const blobUrl = URL.createObjectURL(blob);
        this.nodePreviewImages[id] = [blobUrl];
      });
      api.init();
    }
    #addKeyboardHandler() {
      window.addEventListener("keydown", (e) => {
        this.shiftDown = e.shiftKey;
      });
      window.addEventListener("keyup", (e) => {
        this.shiftDown = e.shiftKey;
      });
    }
    #addConfigureHandler() {
      const app3 = this;
      const configure = LGraph.prototype.configure;
      LGraph.prototype.configure = function() {
        app3.configuringGraph = true;
        try {
          return configure.apply(this, arguments);
        } finally {
          app3.configuringGraph = false;
        }
      };
    }
    #addAfterConfigureHandler() {
      const app3 = this;
      const onConfigure = app3.graph.onConfigure;
      app3.graph.onConfigure = function() {
        for (const node of app3.graph._nodes) {
          node.onGraphConfigured?.();
        }
        const r = onConfigure?.apply(this, arguments);
        for (const node of app3.graph._nodes) {
          node.onAfterGraphConfigured?.();
        }
        return r;
      };
    }
    /**
     * Loads all extensions from the API into the window in parallel
     */
    async #loadExtensions() {
      const extensions = await api.getExtensions();
      this.logging.addEntry("Comfy.App", "debug", { Extensions: extensions });
      const extensionPromises = extensions.map(async (ext) => {
        try {
          await import(api.apiURL(ext));
        } catch (error) {
          console.error("Error loading extension", ext, error);
        }
      });
      await Promise.all(extensionPromises);
    }
    /**
     * Set up the app on the page
     */
    async setup() {
      await this.#loadExtensions();
      const mainCanvas = document.createElement("canvas");
      mainCanvas.style.touchAction = "none";
      const canvasEl = this.canvasEl = Object.assign(mainCanvas, { id: "graph-canvas" });
      canvasEl.tabIndex = "1";
      document.body.prepend(canvasEl);
      addDomClippingSetting();
      this.#addProcessMouseHandler();
      this.#addProcessKeyHandler();
      this.#addConfigureHandler();
      this.graph = new LGraph();
      this.#addAfterConfigureHandler();
      const canvas = this.canvas = new LGraphCanvas(canvasEl, this.graph);
      this.ctx = canvasEl.getContext("2d");
      LiteGraph.release_link_on_empty_shows_menu = true;
      LiteGraph.alt_drag_do_clone_nodes = true;
      this.graph.start();
      function resizeCanvas() {
        const scale = Math.max(window.devicePixelRatio, 1);
        const { width, height } = canvasEl.getBoundingClientRect();
        canvasEl.width = Math.round(width * scale);
        canvasEl.height = Math.round(height * scale);
        canvasEl.getContext("2d").scale(scale, scale);
        canvas.draw(true, true);
      }
      resizeCanvas();
      window.addEventListener("resize", resizeCanvas);
      await this.#invokeExtensionsAsync("init");
      await this.registerNodes();
      let restored = false;
      try {
        const json = localStorage.getItem("workflow");
        if (json) {
          const workflow = JSON.parse(json);
          this.loadGraphData(workflow);
          restored = true;
        }
      } catch (err) {
        console.error("Error loading previous workflow", err);
      }
      if (!restored) {
        this.loadGraphData();
      }
      setInterval(() => localStorage.setItem("workflow", JSON.stringify(this.graph.serialize())), 1e3);
      this.#addDrawNodeHandler();
      this.#addDrawGroupsHandler();
      this.#addApiUpdateHandlers();
      this.#addDropHandler();
      this.#addCopyHandler();
      this.#addPasteHandler();
      this.#addKeyboardHandler();
      await this.#invokeExtensionsAsync("setup");
    }
    /**
     * Registers nodes with the graph
     */
    async registerNodes() {
      const app3 = this;
      const defs = await api.getNodeDefs();
      await this.registerNodesFromDefs(defs);
      await this.#invokeExtensionsAsync("registerCustomNodes");
    }
    async registerNodesFromDefs(defs) {
      await this.#invokeExtensionsAsync("addCustomNodeDefs", defs);
      const widgets = Object.assign(
        {},
        ComfyWidgets,
        ...(await this.#invokeExtensionsAsync("getCustomWidgets")).filter(Boolean)
      );
      for (const nodeId in defs) {
        const nodeData = defs[nodeId];
        const node = Object.assign(
          function ComfyNode() {
            var inputs = nodeData["input"]["required"];
            if (nodeData["input"]["optional"] != void 0) {
              inputs = Object.assign({}, nodeData["input"]["required"], nodeData["input"]["optional"]);
            }
            const config = { minWidth: 1, minHeight: 1 };
            for (const inputName in inputs) {
              const inputData = inputs[inputName];
              const type = inputData[0];
              let widgetCreated = true;
              if (Array.isArray(type)) {
                Object.assign(config, widgets.COMBO(this, inputName, inputData, app2) || {});
              } else if (`${type}:${inputName}` in widgets) {
                Object.assign(config, widgets[`${type}:${inputName}`](this, inputName, inputData, app2) || {});
              } else if (type in widgets) {
                Object.assign(config, widgets[type](this, inputName, inputData, app2) || {});
              } else {
                this.addInput(inputName, type);
                widgetCreated = false;
              }
              if (widgetCreated && inputData[1]?.forceInput && config?.widget) {
                if (!config.widget.options)
                  config.widget.options = {};
                config.widget.options.forceInput = inputData[1].forceInput;
              }
              if (widgetCreated && inputData[1]?.defaultInput && config?.widget) {
                if (!config.widget.options)
                  config.widget.options = {};
                config.widget.options.defaultInput = inputData[1].defaultInput;
              }
            }
            for (const o in nodeData["output"]) {
              let output = nodeData["output"][o];
              if (output instanceof Array)
                output = "COMBO";
              const outputName = nodeData["output_name"][o] || output;
              const outputShape = nodeData["output_is_list"][o] ? LiteGraph.GRID_SHAPE : LiteGraph.CIRCLE_SHAPE;
              this.addOutput(outputName, output, { shape: outputShape });
            }
            const s = this.computeSize();
            s[0] = Math.max(config.minWidth, s[0] * 1.5);
            s[1] = Math.max(config.minHeight, s[1]);
            this.size = s;
            this.serialize_widgets = true;
            app2.#invokeExtensionsAsync("nodeCreated", this);
          },
          {
            title: nodeData.display_name || nodeData.name,
            comfyClass: nodeData.name,
            nodeData
          }
        );
        node.prototype.comfyClass = nodeData.name;
        this.#addNodeContextMenuHandler(node);
        this.#addDrawBackgroundHandler(node, app2);
        this.#addNodeKeyHandler(node);
        await this.#invokeExtensionsAsync("beforeRegisterNodeDef", node, nodeData);
        LiteGraph.registerNodeType(nodeId, node);
        node.category = nodeData.category;
      }
    }
    loadTemplateData(templateData) {
      if (!templateData?.templates) {
        return;
      }
      const old = localStorage.getItem("litegrapheditor_clipboard");
      var maxY, nodeBottom, node;
      for (const template of templateData.templates) {
        if (!template?.data) {
          continue;
        }
        localStorage.setItem("litegrapheditor_clipboard", template.data);
        app2.canvas.pasteFromClipboard();
        maxY = false;
        for (const i in app2.canvas.selected_nodes) {
          node = app2.canvas.selected_nodes[i];
          nodeBottom = node.pos[1] + node.size[1];
          if (maxY === false || nodeBottom > maxY) {
            maxY = nodeBottom;
          }
        }
        app2.canvas.graph_mouse[1] = maxY + 50;
      }
      localStorage.setItem("litegrapheditor_clipboard", old);
    }
    showMissingNodesError(missingNodeTypes, hasAddedNodes = true) {
      this.ui.dialog.show(
        `When loading the graph, the following node types were not found: <ul>${Array.from(new Set(missingNodeTypes)).map(
          (t) => `<li>${t}</li>`
        ).join("")}</ul>${hasAddedNodes ? "Nodes that have failed to load will show as red on the graph." : ""}`
      );
      this.logging.addEntry("Comfy.App", "warn", {
        MissingNodes: missingNodeTypes
      });
    }
    /**
     * Populates the graph with the specified workflow data
     * @param {*} graphData A serialized graph object
     */
    loadGraphData(graphData) {
      this.clean();
      let reset_invalid_values = false;
      if (!graphData) {
        graphData = defaultGraph;
        reset_invalid_values = true;
      }
      if (typeof structuredClone === "undefined") {
        graphData = JSON.parse(JSON.stringify(graphData));
      } else {
        graphData = structuredClone(graphData);
      }
      const missingNodeTypes = [];
      for (let n of graphData.nodes) {
        if (n.type == "T2IAdapterLoader")
          n.type = "ControlNetLoader";
        if (n.type == "ConditioningAverage ")
          n.type = "ConditioningAverage";
        if (n.type == "SDV_img2vid_Conditioning")
          n.type = "SVD_img2vid_Conditioning";
        if (!(n.type in LiteGraph.registered_node_types)) {
          n.type = sanitizeNodeName(n.type);
          missingNodeTypes.push(n.type);
        }
      }
      try {
        this.graph.configure(graphData);
      } catch (error) {
        let errorHint = [];
        const filename = error.fileName || (error.stack || "").match(/(\/extensions\/.*\.js)/)?.[1];
        const pos = (filename || "").indexOf("/extensions/");
        if (pos > -1) {
          errorHint.push(
            $el("span", { textContent: "This may be due to the following script:" }),
            $el("br"),
            $el("span", {
              style: {
                fontWeight: "bold"
              },
              textContent: filename.substring(pos)
            })
          );
        }
        this.ui.dialog.show(
          $el("div", [
            $el("p", { textContent: "Loading aborted due to error reloading workflow data" }),
            $el("pre", {
              style: { padding: "5px", backgroundColor: "rgba(255,0,0,0.2)" },
              textContent: error.toString()
            }),
            $el("pre", {
              style: {
                padding: "5px",
                color: "#ccc",
                fontSize: "10px",
                maxHeight: "50vh",
                overflow: "auto",
                backgroundColor: "rgba(0,0,0,0.2)"
              },
              textContent: error.stack || "No stacktrace available"
            }),
            ...errorHint
          ]).outerHTML
        );
        return;
      }
      for (const node of this.graph._nodes) {
        const size = node.computeSize();
        size[0] = Math.max(node.size[0], size[0]);
        size[1] = Math.max(node.size[1], size[1]);
        node.size = size;
        if (node.widgets) {
          for (let widget of node.widgets) {
            if (node.type == "KSampler" || node.type == "KSamplerAdvanced") {
              if (widget.name == "sampler_name") {
                if (widget.value.startsWith("sample_")) {
                  widget.value = widget.value.slice(7);
                }
              }
            }
            if (node.type == "KSampler" || node.type == "KSamplerAdvanced" || node.type == "PrimitiveNode") {
              if (widget.name == "control_after_generate") {
                if (widget.value === true) {
                  widget.value = "randomize";
                } else if (widget.value === false) {
                  widget.value = "fixed";
                }
              }
            }
            if (reset_invalid_values) {
              if (widget.type == "combo") {
                if (!widget.options.values.includes(widget.value) && widget.options.values.length > 0) {
                  widget.value = widget.options.values[0];
                }
              }
            }
          }
        }
        this.#invokeExtensions("loadedGraphNode", node);
      }
      if (missingNodeTypes.length) {
        this.showMissingNodesError(missingNodeTypes);
      }
    }
    /**
     * Converts the current graph workflow for sending to the API
     * @returns The workflow and node links
     */
    async graphToPrompt() {
      for (const node of this.graph.computeExecutionOrder(false)) {
        if (node.isVirtualNode) {
          if (node.applyToGraph) {
            node.applyToGraph();
          }
          continue;
        }
      }
      const workflow = this.graph.serialize();
      const output = {};
      for (const node of this.graph.computeExecutionOrder(false)) {
        const n = workflow.nodes.find((n2) => n2.id === node.id);
        if (node.isVirtualNode) {
          continue;
        }
        if (node.mode === 2 || node.mode === 4) {
          continue;
        }
        const inputs = {};
        const widgets = node.widgets;
        if (widgets) {
          for (const i in widgets) {
            const widget = widgets[i];
            if (!widget.options || widget.options.serialize !== false) {
              inputs[widget.name] = widget.serializeValue ? await widget.serializeValue(n, i) : widget.value;
            }
          }
        }
        for (let i in node.inputs) {
          let parent = node.getInputNode(i);
          if (parent) {
            let link = node.getInputLink(i);
            while (parent.mode === 4 || parent.isVirtualNode) {
              let found = false;
              if (parent.isVirtualNode) {
                link = parent.getInputLink(link.origin_slot);
                if (link) {
                  parent = parent.getInputNode(link.target_slot);
                  if (parent) {
                    found = true;
                  }
                }
              } else if (link && parent.mode === 4) {
                let all_inputs = [link.origin_slot];
                if (parent.inputs) {
                  all_inputs = all_inputs.concat(Object.keys(parent.inputs));
                  for (let parent_input in all_inputs) {
                    parent_input = all_inputs[parent_input];
                    if (parent.inputs[parent_input]?.type === node.inputs[i].type) {
                      link = parent.getInputLink(parent_input);
                      if (link) {
                        parent = parent.getInputNode(parent_input);
                      }
                      found = true;
                      break;
                    }
                  }
                }
              }
              if (!found) {
                break;
              }
            }
            if (link) {
              inputs[node.inputs[i].name] = [String(link.origin_id), parseInt(link.origin_slot)];
            }
          }
        }
        output[String(node.id)] = {
          inputs,
          class_type: node.comfyClass
        };
      }
      for (const o in output) {
        for (const i in output[o].inputs) {
          if (Array.isArray(output[o].inputs[i]) && output[o].inputs[i].length === 2 && !output[output[o].inputs[i][0]]) {
            delete output[o].inputs[i];
          }
        }
      }
      return { workflow, output };
    }
    #formatPromptError(error) {
      if (error == null) {
        return "(unknown error)";
      } else if (typeof error === "string") {
        return error;
      } else if (error.stack && error.message) {
        return error.toString();
      } else if (error.response) {
        let message = error.response.error.message;
        if (error.response.error.details)
          message += ": " + error.response.error.details;
        for (const [nodeID, nodeError] of Object.entries(error.response.node_errors)) {
          message += "\n" + nodeError.class_type + ":";
          for (const errorReason of nodeError.errors) {
            message += "\n    - " + errorReason.message + ": " + errorReason.details;
          }
        }
        return message;
      }
      return "(unknown error)";
    }
    #formatExecutionError(error) {
      if (error == null) {
        return "(unknown error)";
      }
      const traceback = error.traceback.join("");
      const nodeId = error.node_id;
      const nodeType = error.node_type;
      return `Error occurred when executing ${nodeType}:

${error.exception_message}

${traceback}`;
    }
    async queuePrompt(number, batchCount = 1) {
      this.#queueItems.push({ number, batchCount });
      if (this.#processingQueue) {
        return;
      }
      this.#processingQueue = true;
      this.lastNodeErrors = null;
      try {
        while (this.#queueItems.length) {
          ({ number, batchCount } = this.#queueItems.pop());
          for (let i = 0; i < batchCount; i++) {
            const p = await this.graphToPrompt();
            try {
              const res = await api.queuePrompt(number, p);
              this.lastNodeErrors = res.node_errors;
              if (this.lastNodeErrors.length > 0) {
                this.canvas.draw(true, true);
              }
            } catch (error) {
              const formattedError = this.#formatPromptError(error);
              this.ui.dialog.show(formattedError);
              if (error.response) {
                this.lastNodeErrors = error.response.node_errors;
                this.canvas.draw(true, true);
              }
              break;
            }
            for (const n of p.workflow.nodes) {
              const node = graph.getNodeById(n.id);
              if (node.widgets) {
                for (const widget of node.widgets) {
                  if (widget.afterQueued) {
                    widget.afterQueued();
                  }
                }
              }
            }
            this.canvas.draw(true, true);
            await this.ui.queue.update();
          }
        }
      } finally {
        this.#processingQueue = false;
      }
    }
    /**
     * Loads workflow data from the specified file
     * @param {File} file
     */
    async handleFile(file) {
      if (file.type === "image/png") {
        const pngInfo = await getPngMetadata(file);
        if (pngInfo) {
          if (pngInfo.workflow) {
            this.loadGraphData(JSON.parse(pngInfo.workflow));
          } else if (pngInfo.parameters) {
            importA1111(this.graph, pngInfo.parameters);
          }
        }
      } else if (file.type === "image/webp") {
        const pngInfo = await getWebpMetadata(file);
        if (pngInfo) {
          if (pngInfo.workflow) {
            this.loadGraphData(JSON.parse(pngInfo.workflow));
          } else if (pngInfo.Workflow) {
            this.loadGraphData(JSON.parse(pngInfo.Workflow));
          }
        }
      } else if (file.type === "application/json" || file.name?.endsWith(".json")) {
        const reader = new FileReader();
        reader.onload = () => {
          const jsonContent = JSON.parse(reader.result);
          if (jsonContent?.templates) {
            this.loadTemplateData(jsonContent);
          } else if (this.isApiJson(jsonContent)) {
            this.loadApiJson(jsonContent);
          } else {
            this.loadGraphData(jsonContent);
          }
        };
        reader.readAsText(file);
      } else if (file.name?.endsWith(".latent") || file.name?.endsWith(".safetensors")) {
        const info = await getLatentMetadata(file);
        if (info.workflow) {
          this.loadGraphData(JSON.parse(info.workflow));
        }
      }
    }
    isApiJson(data) {
      return Object.values(data).every((v) => v.class_type);
    }
    loadApiJson(apiData) {
      const missingNodeTypes = Object.values(apiData).filter((n) => !LiteGraph.registered_node_types[n.class_type]);
      if (missingNodeTypes.length) {
        this.showMissingNodesError(missingNodeTypes.map((t) => t.class_type), false);
        return;
      }
      const ids = Object.keys(apiData);
      app2.graph.clear();
      for (const id of ids) {
        const data = apiData[id];
        const node = LiteGraph.createNode(data.class_type);
        node.id = isNaN(+id) ? id : +id;
        graph.add(node);
      }
      for (const id of ids) {
        const data = apiData[id];
        const node = app2.graph.getNodeById(id);
        for (const input in data.inputs ?? {}) {
          const value = data.inputs[input];
          if (value instanceof Array) {
            const [fromId, fromSlot] = value;
            const fromNode = app2.graph.getNodeById(fromId);
            const toSlot = node.inputs?.findIndex((inp) => inp.name === input);
            if (toSlot !== -1) {
              fromNode.connect(fromSlot, node, toSlot);
            }
          } else {
            const widget = node.widgets?.find((w) => w.name === input);
            if (widget) {
              widget.value = value;
              widget.callback?.(value);
            }
          }
        }
      }
      app2.graph.arrange();
    }
    /**
     * Registers a Comfy web extension with the app
     * @param {ComfyExtension} extension
     */
    registerExtension(extension) {
      if (!extension.name) {
        throw new Error("Extensions must have a 'name' property.");
      }
      if (this.extensions.find((ext) => ext.name === extension.name)) {
        throw new Error(`Extension named '${extension.name}' already registered.`);
      }
      this.extensions.push(extension);
    }
    /**
     * Refresh combo list on whole nodes
     */
    async refreshComboInNodes() {
      const defs = await api.getNodeDefs();
      for (const nodeId in LiteGraph.registered_node_types) {
        const node = LiteGraph.registered_node_types[nodeId];
        const nodeDef = defs[nodeId];
        if (!nodeDef)
          continue;
        node.nodeData = nodeDef;
      }
      for (let nodeNum in this.graph._nodes) {
        const node = this.graph._nodes[nodeNum];
        const def = defs[node.type];
        node.refreshComboInNode?.(defs);
        if (!def)
          continue;
        for (const widgetNum in node.widgets) {
          const widget = node.widgets[widgetNum];
          if (widget.type == "combo" && def["input"]["required"][widget.name] !== void 0) {
            widget.options.values = def["input"]["required"][widget.name][0];
            if (widget.name != "image" && !widget.options.values.includes(widget.value)) {
              widget.value = widget.options.values[0];
              widget.callback(widget.value);
            }
          }
        }
      }
    }
    /**
     * Clean current state
     */
    clean() {
      this.nodeOutputs = {};
      this.nodePreviewImages = {};
      this.lastNodeErrors = null;
      this.lastExecutionError = null;
      this.runningNodeId = null;
    }
  };
  var app2 = new ComfyApp();

  // index.js
  async function main() {
    await app2.setup();
    window.app = app2;
    window.graph = app2.graph;
  }
  main();
})();
