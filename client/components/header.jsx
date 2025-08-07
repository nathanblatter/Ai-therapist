// Header.jsx
import React from 'react';
import { useState } from 'react';
import CopyButton from './copyButton';

const Header = ({ sessionId }) => {
  return (
    <header className="bg-byuNavy text-white p-4 md:p-6 font-sans">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl md:text-5xl font-bold text-center">AI Therapist Assistant</h1>
         {/* 🔹 Show Session ID if it exists */}
         {sessionId && (
          <p className="text-center text-lg text-gray-300 mt-1 flex justify-center items-center gap-2">
          <span>Session ID:</span>
          <code className="bg-byuRoyal px-2 py-1 rounded font-bold text-white">{sessionId}</code>
          <CopyButton textToCopy={sessionId} />
        </p>
        
        )}
        <p className="mt-2 text-sm md:text-base leading-relaxed">
          If you experience emotional distress, crisis, or worsening mental health symptoms at any point during your session please reach out immediately to BYU's Counseling and Psychological Services crisis line at 
          <a href="tel:8014223035" className="text-blue-300 underline ml-1" title="BYU Counseling and Psychological Services Crisis Line">(801) 422-3035</a> or visit 
          <a href="https://caps.byu.edu" target="_blank" rel="noopener noreferrer" className="text-blue-300 underline ml-1" title="BYU Counseling and Psychological services Website">caps.byu.edu</a> for support. You are not alone—help is available.
        </p>
        <nav className="mt-4 flex flex-col sm:flex-row items-center gap-2 sm:gap-4 justify-center">
          <a href="tel:8014223035" className="bg-byuRoyal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center" title="BYU Counseling and Psychological Services">Call CAPS</a>
          <a href="https://caps.byu.edu/for-students-in-crisis" target="_blank" rel="noopener noreferrer" className="bg-byuRoyal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center" title="BYU Crisis Resources">Crisis Resources</a>
        </nav>
        
      </div>
    </header>
  );
};

export default Header;