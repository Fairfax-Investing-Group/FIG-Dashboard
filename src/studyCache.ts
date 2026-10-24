import type { StudyDocument } from './types';

/** Keep recent studies fast without retaining every visited provider document. */
export class StudyCache extends Map<string, StudyDocument> {
  constructor(private readonly limit = 4) { super(); }
  get(id: string) {
    const value = super.get(id);
    if (value) { super.delete(id); super.set(id, value); }
    return value;
  }
  set(id: string, value: StudyDocument): this {
    super.delete(id);
    super.set(id, value);
    while (this.size > this.limit) super.delete(this.keys().next().value!);
    return this;
  }
}
