import { GeocodeError } from './geocoder.js';
import { escapeHtml, formatDistance } from './format.js';
import { distanceMeters } from './geo.js';

/**
 * Destination search field with a keyboard-navigable result list.
 * Searches on submit (Enter / search button), never per keystroke: the
 * Nominatim usage policy forbids search-as-you-type.
 */
export class SearchBox {
  constructor({ form, input, results, message, geocoder, getViewbox, onSelect, onCleared }) {
    this.form = form;
    this.input = input;
    this.results = results;
    this.message = message;
    this.geocoder = geocoder;
    this.getViewbox = getViewbox;
    this.onSelect = onSelect;
    this.onCleared = onCleared;
    this.places = [];
    this.active = -1;
    this.busy = false;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.active >= 0 && !this.results.hidden) this.choose(this.active);
      else this.search();
    });
    input.addEventListener('keydown', (e) => this._onKey(e));
    input.addEventListener('input', () => {
      if (!input.value.trim()) {
        this._closeResults();
        this._setMessage('');
        this.onCleared();
      }
    });
    results.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-index]');
      if (li) this.choose(Number(li.dataset.index));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!form.contains(e.target)) this._closeResults();
    });
  }

  setValue(text) {
    this.input.value = text;
  }

  async search() {
    const query = this.input.value;
    this._closeResults();
    this._setMessage('Searching...');
    this.form.setAttribute('aria-busy', 'true');
    try {
      const viewbox = this.getViewbox();
      const { places, scope } = await this.geocoder.search(query, { viewbox });
      if (query !== this.input.value) return; // user typed on; this answer is outdated
      this.places = places;
      if (!places.length) {
        this._setMessage('No places found. Try another name, or tap the map to choose a destination.');
        return;
      }
      this._setMessage(scope === 'global' ? 'Nothing found near the map - showing results further away.' : '');
      this._renderResults(viewbox);
    } catch (err) {
      if (err instanceof GeocodeError && err.code === 'aborted') return;
      this._setMessage(err instanceof GeocodeError ? err.message : 'Search failed.', true);
    } finally {
      this.form.removeAttribute('aria-busy');
    }
  }

  choose(index) {
    const place = this.places[index];
    if (!place) return;
    this.input.value = place.name;
    this._closeResults();
    this._setMessage('');
    this.onSelect(place);
  }

  _renderResults(viewbox) {
    const center = viewbox ? { lat: (viewbox.north + viewbox.south) / 2, lng: (viewbox.east + viewbox.west) / 2 } : null;
    this.results.innerHTML = this.places.map((p, i) => {
      const away = center ? `<span class="nv-result-dist">${formatDistance(distanceMeters(center, p))} away</span>` : '';
      return `<li role="option" id="nv-result-${i}" data-index="${i}" aria-selected="false" class="nv-result">
        <span class="nv-result-name">${escapeHtml(p.name)}${away}</span>
        <span class="nv-result-addr">${escapeHtml(p.address)}</span></li>`;
    }).join('');
    this.results.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this._highlight(-1);
  }

  _closeResults() {
    this.results.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.active = -1;
  }

  _highlight(index) {
    this.active = index;
    this.results.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
      this.input.setAttribute('aria-activedescendant', `nv-result-${index}`);
      const li = this.results.children[index];
      if (li) li.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  _onKey(e) {
    if (this.results.hidden || !this.places.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); this._highlight((this.active + 1) % this.places.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this._highlight(this.active <= 0 ? this.places.length - 1 : this.active - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); this._closeResults(); }
  }

  _setMessage(text, isError = false) {
    this.message.textContent = text;
    this.message.hidden = !text;
    this.message.classList.toggle('nv-error', isError);
  }
}
