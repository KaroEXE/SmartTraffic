import { formatCoords } from './format.js';

/**
 * "Report an incident" dialog (a native <dialog>, so focus handling and Escape come from the
 * browser). open(point) shows it for a map point; submitting calls
 * onSubmit({ type, description, point }); the dialog shows the error if that throws and
 * stays open so nothing typed is lost.
 */

const TYPES = [
  ['accident', 'Accident'],
  ['traffic_jam', 'Traffic jam'],
  ['road_closure', 'Road closed'],
  ['construction', 'Roadworks'],
  ['hazard', 'Hazard on the road'],
];

export class ReportDialog {
  constructor({ dialog, onSubmit, maxLength = 280 }) {
    this.dialog = dialog;
    this.onSubmit = onSubmit;
    this.point = null;
    dialog.innerHTML = `<form method="dialog" class="nv-report-form" novalidate>
      <h2 id="nv-report-title">Report an incident</h2>
      <p class="nv-report-where" data-where></p>
      <fieldset class="nv-report-types"><legend>What is happening?</legend>
        ${TYPES.map(([value, label], i) => `<label><input type="radio" name="type" value="${value}"${i === 0 ? ' checked' : ''}> ${label}</label>`).join('')}
      </fieldset>
      <label class="nv-report-note">Details (optional)
        <textarea name="description" rows="3" maxlength="${maxLength}" placeholder="For example: two cars blocking the left lane"></textarea>
      </label>
      <p class="nv-report-error" role="alert" data-error hidden></p>
      <p class="nv-report-hint">Reports are public, shown until they expire, and can be confirmed or disputed by other drivers.</p>
      <div class="nv-report-actions">
        <button type="button" class="nv-btn" data-cancel>Cancel</button>
        <button type="submit" class="nv-btn nv-btn-primary" data-send>Send report</button>
      </div></form>`;
    dialog.setAttribute('aria-labelledby', 'nv-report-title');
    this.form = dialog.querySelector('form');
    this.where = dialog.querySelector('[data-where]');
    this.error = dialog.querySelector('[data-error]');
    this.send = dialog.querySelector('[data-send]');
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this._submit(); });
  }

  open(point) {
    this.point = point;
    this.where.textContent = `At ${formatCoords(point)}`;
    this.error.hidden = true;
    this.send.disabled = false;
    this.form.reset();
    this.dialog.showModal();
    this.form.querySelector('input[name="type"]:checked').focus();
  }

  async _submit() {
    const data = new FormData(this.form);
    this.send.disabled = true;
    this.error.hidden = true;
    try {
      await this.onSubmit({ type: data.get('type'), description: String(data.get('description') || ''), point: this.point });
      this.dialog.close();
    } catch (err) {
      this.error.textContent = err && err.message ? err.message : 'The report could not be sent.';
      this.error.hidden = false;
      this.send.disabled = false;
    }
  }
}
