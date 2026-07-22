import { Dispatch, SetStateAction, useEffect, useState } from 'react';

export type Message = {
  id: string;
  author: string;
  text: string;
  time: string;
  own?: boolean;
  attachment?: Attachment;
};

export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
};

export type TextChannel = {
  id: string;
  name: string;
};

export const defaultChannels: TextChannel[] = [
  { id: 'general', name: 'общий' },
  { id: 'development', name: 'разработка' },
  { id: 'meet', name: 'знакомства' },
];

export const defaultMessages: Record<string, Message[]> = {
  general: [
    {
      id: 'welcome',
      author: 'RIFT',
      text: 'Комната создана на твоём устройстве. Здесь нет центрального сервера.',
      time: 'сейчас',
    },
  ],
  development: [],
  meet: [],
};

export function useLocalStorageState<T>(
  key: string,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) as T : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or a full storage quota should not break the chat UI.
    }
  }, [key, value]);

  return [value, setValue];
}
