(() => {
  const root = document.documentElement;
  const menu = document.querySelector("#themeMenu");
  const button = document.querySelector("#themeButton");
  const modal = document.querySelector("#modal");
  const modalContent = document.querySelector("#modalContent");
  const names = { sky: "天青", jade: "翡翠", sunset: "晚霞", graphite: "深灰" };
  const applyTheme = (theme) => {
    const safe = Object.hasOwn(names, theme) ? theme : "sky";
    root.dataset.theme = safe;
    button.querySelector(".theme-label").textContent = names[safe];
    localStorage.setItem("vault-muse-demo-theme", safe);
  };
  applyTheme(localStorage.getItem("vault-muse-demo-theme") || "sky");

  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  });
  menu.addEventListener("click", (event) => {
    const target = event.target.closest("[data-theme]");
    if (!target) return;
    applyTheme(target.dataset.theme);
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".theme-wrap")) menu.hidden = true;
  });

  const openModal = (templateId) => {
    const template = document.querySelector(`#${templateId}`);
    modalContent.replaceChildren(template.content.cloneNode(true));
    modal.showModal();
  };
  document.querySelector("#modalClose").addEventListener("click", () => modal.close());
  document.querySelector("#infoButton").addEventListener("click", () => openModal("privacyTemplate"));
  document.querySelector("#proposalButton").addEventListener("click", () => openModal("proposalTemplate"));
  document.querySelector("#contextButton").addEventListener("click", () => openModal("contextTemplate"));
  document.querySelector("#addContext").addEventListener("click", () => toast("演示：可添加标签、打开的笔记或图片"));

  const composer = document.querySelector("#composer");
  const send = () => {
    const text = composer.value.trim();
    if (!text) return toast("先写下一点想法吧");
    const message = document.createElement("article");
    message.className = "message user";
    const p = document.createElement("p");
    p.textContent = text;
    message.append(p);
    document.querySelector("#messages").append(message);
    composer.value = "";
    message.scrollIntoView({ behavior: "smooth" });
    toast("演示消息仅留在当前页面");
  };
  document.querySelector("#sendButton").addEventListener("click", send);
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  });
  function toast(text) {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div"); el.className = "toast"; el.textContent = text;
    document.body.append(el); setTimeout(() => el.remove(), 1800);
  }
})();
