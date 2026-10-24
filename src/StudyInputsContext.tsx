import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { SavedStudy, StudyUserValues } from './lib/studyInputs';

type InputsContext = {
  initial?: SavedStudy;
  record: { current: SavedStudy | undefined };
  sections: Map<string, StudyUserValues>;
  collect: () => StudyUserValues;
};
const Context = createContext<InputsContext | null>(null);

export function StudyInputsProvider({ initial, children }: { initial?: SavedStudy; children: ReactNode }) {
  const sections = useRef(new Map<string, StudyUserValues>());
  const record = useRef(initial);
  const value = useMemo(() => ({ initial, record, sections: sections.current,
    collect: () => Object.assign({ title: initial?.title ?? null, notes: initial?.notes ?? null }, ...sections.current.values()) as StudyUserValues,
  }), [initial]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useStudyInputs = () => useContext(Context);

/** Capture only editable assumptions; provider data never enters this registry. */
export function useStudyInputSection(name: string, values: StudyUserValues) {
  const context = useStudyInputs();
  useLayoutEffect(() => {
    context?.sections.set(name, values);
    return () => { context?.sections.delete(name); };
  }, [context, name, values]);
}

export function inputNumber(value: string | null): number | null {
  return value === null || !value.trim() ? null : Number(value);
}
