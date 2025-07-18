// Header.jsx
import React from 'react';
import { useState } from 'react';


const Header = () => {
  return (
    <header className="bg-byuNavy text-white p-6 font-sans">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-5xl font-bold text-center">AI Therapist Assistant</h1>
        <p className="mt-2 text-base leading-relaxed">
          If you experience emotional distress, crisis, or worsening mental health symptoms at any point during your session, please reach out immediately to BYU's Counseling and Psychological Services crisis line at 
          <a href="tel:8014223035" className="text-blue-300 underline ml-1">(801) 422-3035</a> or visit 
          <a href="https://caps.byu.edu" target="_blank" rel="noopener noreferrer" className="text-blue-300 underline ml-1">caps.byu.edu</a> for support. You are not alone—help is available.
        </p>
        <nav className="mt-4 flex gap-4 justify-center">
          <a href="tel:8014223035" className="bg-byuRoyal hover:bg-gray-700 px-4 py-2 rounded-full text-sm font-semibold">Call CAPS</a>
          <a href="https://caps.byu.edu/for-students-in-crisis" target="_blank" rel="noopener noreferrer" className="bg-byuRoyal hover:bg-gray-700 px-4 py-2 rounded-full text-sm font-semibold">Crisis Resources</a>
        </nav>
      </div>
    </header>
  );
};

export default Header;

