
import { useState, useEffect } from 'react';

interface KeyboardProps {
    onSave: () => void;
    onOpen: () => void;
}

export const useKeyboard = ({ onSave, onOpen }: KeyboardProps) => {
  const [isAltPressed, setIsAltPressed] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isMiddleMousePressed, setIsMiddleMousePressed] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Alt') { 
        e.preventDefault(); 
        setIsAltPressed(true); 
        document.body.classList.add('alt-active');
      }
      if (e.key === ' ') { 
        e.preventDefault(); 
        setIsSpacePressed(true); 
        document.body.classList.add('space-panning');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); onOpen(); }
    };

    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setIsAltPressed(false);
        document.body.classList.remove('alt-active');
      }
      if (e.key === ' ') {
        setIsSpacePressed(false);
        document.body.classList.remove('space-panning');
      }
    };

    const mouseDown = (e: MouseEvent) => { 
      if (e.button === 1) {
        setIsMiddleMousePressed(true);
        document.body.classList.add('space-panning');
      }
      if (e.button === 2) {
        document.body.classList.add('right-panning');
      }
    };

    const mouseUp = (e: MouseEvent) => { 
      if (e.button === 1) {
        setIsMiddleMousePressed(false);
        document.body.classList.remove('space-panning');
      }
      if (e.button === 2) {
        document.body.classList.remove('right-panning');
      }
    };

    const blur = () => { 
      setIsAltPressed(false); 
      setIsSpacePressed(false); 
      setIsMiddleMousePressed(false);
      document.body.classList.remove('alt-active', 'space-panning', 'right-panning');
    };
    
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mouseDown);
    window.addEventListener('mouseup', mouseUp);
    window.addEventListener('blur', blur);

    return () => { 
      window.removeEventListener('keydown', down); 
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('blur', blur);
    };
  }, [onSave, onOpen]);

  return { isAltPressed, isSpacePressed, isMiddleMousePressed };
};
