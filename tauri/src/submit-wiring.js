// Submit wiring for the restricted guest. The sandbox CSP carries
// form-action 'none', so the dialog-method submission never fires a submit
// event (neither requestSubmit nor the submit button reaches the app's
// handler). The build rewrites the post button to type="button"; this
// wiring replays a submit to the app's own handler, which validates the
// fields and posts exactly as before.
;(function () {
  var button = document.getElementById("post-submit");
  var form = document.getElementById("post-form");
  if (!button || !form) return;
  button.addEventListener("click", function () {
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
})();
